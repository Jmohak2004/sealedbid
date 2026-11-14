// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// QoreChain post-quantum precompiles (testnet): 0x0a01 pqcVerify, 0x0a02 pqcKeyStatus.
interface IQorePQC {
    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external view returns (bool valid);
    function pqcKeyStatus(address account)
        external view returns (bool registered, uint8 algorithmId, bytes memory pubkey, bool possessionProven);
}

/// SealedBid: a sealed-bid, second-price (Vickrey) auction for QoreChain.
///
/// Privacy: a bid is sealed off-chain to the seller's registered ML-KEM-1024 key (QoreSeal). Only a hash of the
/// ciphertext and a salted commitment of the bid go on-chain, so nobody (other bidders, validators, front-runners)
/// learns an amount before the reveal phase.
///
/// Authenticity: at reveal the contract checks, via the pqcVerify precompile, an ML-DSA-87 signature by the
/// bidder's REGISTERED post-quantum key over the exact bid. The seller can therefore reveal on bidders' behalf
/// ("bid and walk away") but can never invent, alter or swap a bid. Any bidder can also reveal their own bid,
/// so a censoring seller cannot suppress it.
///
/// Q-Day hardening: every movement of value requires an ML-DSA-87 signature from the account's registered key,
/// in BOTH directions: payouts (withdraw) and deposits (commitBid). A recovered classical (ECDSA) key alone can
/// neither drain an account nor force its funds into an auction, even while an EVM window is open.
contract SealedBidAuction {
    // ---------------------------------------------------------------- config
    IQorePQC public immutable pqcVerifier; // 0x...0a01 on QoreChain testnet
    IQorePQC public immutable pqcStatus;   // 0x...0a02 on QoreChain testnet

    bytes32 public constant BID_DOMAIN = keccak256("SEALEDBID_BID_V1");
    bytes32 public constant COMMIT_DOMAIN = keccak256("SEALEDBID_COMMIT_V1");
    bytes32 public constant WITHDRAW_DOMAIN = keccak256("SEALEDBID_WITHDRAW_V1");

    constructor(address verifier, address status) {
        pqcVerifier = IQorePQC(verifier);
        pqcStatus = IQorePQC(status);
    }

    // ---------------------------------------------------------------- state
    enum BidStatus { None, Committed, Revealed, Withdrawn }

    struct Auction {
        address seller;
        bytes32 kemKeyHash;     // keccak256 of the seller's ML-KEM-1024 public key bidders sealed to
        string itemURI;
        uint256 reserve;        // minimum price, > 0
        uint256 deposit;        // fixed, public deposit every bid must lock (hides the bid size)
        uint64 commitEnd;
        uint64 revealEnd;
        uint64 payEnd;
        uint32 bidCount;
        uint32 revealedCount;
        // outcome
        bool finalized;
        address winner;         // address(0) when no sale
        uint256 price;          // second-price (or reserve)
        bool paid;
        bool forfeited;         // winner failed to pay in time
        uint256 sellerProceeds; // withdrawable by the seller
        // running reveal tally
        address topBidder;
        uint256 topAmount;
        uint32 topIndex;
        uint256 secondAmount;
    }

    struct Bid {
        bytes32 commitment;   // keccak256(abi.encode(auctionId, bidder, amount, salt))
        bytes32 envelopeHash; // keccak256 of the sealed ML-KEM envelope (audit anchor)
        uint32 index;         // commit order, breaks ties
        BidStatus status;
        uint256 amount;       // 0 until revealed
    }

    struct Reveal {
        address bidder;
        uint256 amount;
        bytes32 salt;
        bytes signature; // ML-DSA-87 over bidDigest(...)
    }

    uint256 public auctionCount;
    mapping(uint256 => Auction) internal _auctions;
    mapping(uint256 => mapping(address => Bid)) public bids;
    mapping(address => uint256) public withdrawNonce;

    // ---------------------------------------------------------------- events
    event AuctionCreated(uint256 indexed id, address indexed seller, string itemURI, bytes32 kemKeyHash,
        uint256 reserve, uint256 deposit, uint64 commitEnd, uint64 revealEnd, uint64 payEnd);
    event BidCommitted(uint256 indexed id, address indexed bidder, bytes32 commitment, bytes32 envelopeHash);
    event BidRevealed(uint256 indexed id, address indexed bidder, uint256 amount);
    event Finalized(uint256 indexed id, address indexed winner, uint256 price);
    event WinnerPaid(uint256 indexed id, address indexed winner, uint256 price);
    event WinnerForfeited(uint256 indexed id, address indexed winner);
    event Withdrawn(uint256 indexed id, address indexed account, uint256 amount);

    // ---------------------------------------------------------------- views
    function auctionInfo(uint256 id) external view returns (Auction memory) { return _auctions[id]; }

    /// What a signer must sign (as the raw 32-byte value) to bind a bid. Mirrored byte-for-byte in src/sealedbid.
    function bidDigest(uint256 id, address bidder, uint256 amount, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(BID_DOMAIN, block.chainid, address(this), id, bidder, amount, salt));
    }

    /// What a bidder signs to authorise locking their deposit in this exact bid.
    function commitDigest(uint256 id, address bidder, bytes32 commitment, bytes32 envelopeHash) public view returns (bytes32) {
        return keccak256(abi.encode(COMMIT_DOMAIN, block.chainid, address(this), id, bidder, commitment, envelopeHash));
    }

    function commitmentOf(uint256 id, address bidder, uint256 amount, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(id, bidder, amount, salt));
    }

    function withdrawDigest(uint256 id, address account) public view returns (bytes32) {
        return keccak256(abi.encode(WITHDRAW_DOMAIN, block.chainid, address(this), id, account, withdrawNonce[account]));
    }

    /// How much `account` could withdraw from auction `id` right now.
    function owed(uint256 id, address account) public view returns (uint256) {
        Auction storage a = _auctions[id];
        if (!a.finalized) return 0;
        if (account == a.seller) return a.sellerProceeds;
        Bid storage b = bids[id][account];
        if (b.status != BidStatus.Revealed) return 0;
        if (a.winner == account) {
            // winner: paid -> refund any deposit above the price; unpaid -> nothing
            if (!a.paid) return 0;
            return a.deposit > a.price ? a.deposit - a.price : 0;
        }
        return a.deposit; // revealed loser (or no sale): full deposit back
    }

    // ---------------------------------------------------------------- seller
    function createAuction(
        string calldata itemURI, bytes32 kemKeyHash, uint256 reserve, uint256 deposit,
        uint64 commitSecs, uint64 revealSecs, uint64 paySecs
    ) external returns (uint256 id) {
        require(reserve > 0, "reserve=0");
        require(commitSecs > 0 && revealSecs > 0 && paySecs > 0, "durations");
        _requirePqKey(msg.sender);
        id = ++auctionCount;
        Auction storage a = _auctions[id];
        a.seller = msg.sender;
        a.kemKeyHash = kemKeyHash;
        a.itemURI = itemURI;
        a.reserve = reserve;
        a.deposit = deposit;
        a.commitEnd = uint64(block.timestamp) + commitSecs;
        a.revealEnd = a.commitEnd + revealSecs;
        a.payEnd = a.revealEnd + paySecs;
        emit AuctionCreated(id, msg.sender, itemURI, kemKeyHash, reserve, deposit, a.commitEnd, a.revealEnd, a.payEnd);
    }

    // ---------------------------------------------------------------- bidder
    /// Lock the fixed deposit and commit to a sealed bid. Only hashes are stored. The ML-DSA signature proves the
    /// registered post-quantum key holder (not merely whoever holds the ECDSA key) authorised this deposit.
    function commitBid(uint256 id, bytes32 commitment, bytes32 envelopeHash, bytes calldata pqSignature) external payable {
        Auction storage a = _auctions[id];
        require(a.seller != address(0), "no auction");
        require(block.timestamp < a.commitEnd, "commit closed");
        require(msg.sender != a.seller, "seller cannot bid");
        require(msg.value == a.deposit, "wrong deposit");
        require(bids[id][msg.sender].status == BidStatus.None, "already bid");
        _requireSignedBy(msg.sender, commitDigest(id, msg.sender, commitment, envelopeHash), pqSignature);
        bids[id][msg.sender] = Bid(commitment, envelopeHash, a.bidCount, BidStatus.Committed, 0);
        a.bidCount++;
        emit BidCommitted(id, msg.sender, commitment, envelopeHash);
    }

    // ---------------------------------------------------------------- reveal
    /// Callable by anyone (the seller reveals on bidders' behalf; a bidder can reveal their own bid).
    function reveal(uint256 id, Reveal calldata r) external {
        _reveal(id, r);
    }

    function revealMany(uint256 id, Reveal[] calldata rs) external {
        for (uint256 i = 0; i < rs.length; i++) _reveal(id, rs[i]);
    }

    function _reveal(uint256 id, Reveal calldata r) internal {
        Auction storage a = _auctions[id];
        require(block.timestamp >= a.commitEnd && block.timestamp < a.revealEnd, "not reveal phase");
        Bid storage b = bids[id][r.bidder];
        require(b.status == BidStatus.Committed, "not committed");
        require(r.amount > 0, "amount=0");
        require(commitmentOf(id, r.bidder, r.amount, r.salt) == b.commitment, "commitment mismatch");
        _requireSignedBy(r.bidder, bidDigest(id, r.bidder, r.amount, r.salt), r.signature);

        b.status = BidStatus.Revealed;
        b.amount = r.amount;
        a.revealedCount++;

        if (r.amount > a.topAmount || (r.amount == a.topAmount && b.index < a.topIndex)) {
            a.secondAmount = a.topAmount;
            a.topAmount = r.amount;
            a.topBidder = r.bidder;
            a.topIndex = b.index;
        } else if (r.amount > a.secondAmount) {
            a.secondAmount = r.amount;
        }
        emit BidRevealed(id, r.bidder, r.amount);
    }

    // ---------------------------------------------------------------- settle
    function finalize(uint256 id) external {
        Auction storage a = _auctions[id];
        require(a.seller != address(0), "no auction");
        require(block.timestamp >= a.revealEnd, "reveal not over");
        require(!a.finalized, "finalized");
        a.finalized = true;
        // unrevealed deposits are forfeited to the seller
        a.sellerProceeds += uint256(a.bidCount - a.revealedCount) * a.deposit;
        if (a.topAmount >= a.reserve) {
            a.winner = a.topBidder;
            uint256 second = a.secondAmount > a.reserve ? a.secondAmount : a.reserve;
            a.price = second;
        }
        emit Finalized(id, a.winner, a.price);
    }

    /// The winner pays the second price (their locked deposit counts toward it).
    function payWinning(uint256 id) external payable {
        Auction storage a = _auctions[id];
        require(a.finalized && a.winner != address(0), "no sale");
        require(msg.sender == a.winner, "not winner");
        require(!a.paid && !a.forfeited, "settled");
        require(block.timestamp < a.payEnd, "pay window closed");
        uint256 due = a.price > a.deposit ? a.price - a.deposit : 0;
        require(msg.value == due, "wrong amount");
        a.paid = true;
        a.sellerProceeds += a.price;
        emit WinnerPaid(id, msg.sender, a.price);
    }

    /// If the winner never pays, the seller keeps the winner's deposit and the item stays unsold.
    function claimForfeit(uint256 id) external {
        Auction storage a = _auctions[id];
        require(a.finalized && a.winner != address(0), "no sale");
        require(!a.paid && !a.forfeited, "settled");
        require(block.timestamp >= a.payEnd, "pay window open");
        a.forfeited = true;
        a.sellerProceeds += a.deposit;
        emit WinnerForfeited(id, a.winner);
    }

    // ---------------------------------------------------------------- payout
    /// Pull payment, authorised by an ML-DSA-87 signature over withdrawDigest(id, msg.sender).
    function withdraw(uint256 id, bytes calldata signature) external {
        _requireSignedBy(msg.sender, withdrawDigest(id, msg.sender), signature);
        withdrawNonce[msg.sender]++;

        Auction storage a = _auctions[id];
        uint256 amount = owed(id, msg.sender);
        require(amount > 0, "nothing owed");
        if (msg.sender == a.seller) {
            a.sellerProceeds = 0;
        } else {
            bids[id][msg.sender].status = BidStatus.Withdrawn;
        }
        emit Withdrawn(id, msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
    }

    // ---------------------------------------------------------------- PQ helpers
    function _requirePqKey(address account) internal view {
        (bool registered,, , bool proven) = pqcStatus.pqcKeyStatus(account);
        require(registered && proven, "PQ key not registered/proven");
    }

    function _requireSignedBy(address account, bytes32 digest, bytes calldata signature) internal view {
        (bool registered,, bytes memory pubkey, bool proven) = pqcStatus.pqcKeyStatus(account);
        require(registered && proven, "PQ key not registered/proven");
        require(pqcVerifier.pqcVerify(pubkey, signature, bytes.concat(digest)), "bad ML-DSA signature");
    }
}
