// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// QoreChain PQC precompiles (testnet only): 0x0A01 pqcVerify, 0x0A02 pqcKeyStatus.
interface IQorePQC {
    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external view returns (bool valid);
    function pqcKeyStatus(address account)
        external view returns (bool registered, uint8 algorithmId, bytes memory pubkey, bool possessionProven);
}

/// Spike contract: proves (1) a qorechain-pqc ML-DSA-87 signature verifies on-chain over raw bytes,
/// and (2) a contract can call the precompiles from inside a windowed transaction.
contract PQCProbe {
    IQorePQC internal constant PQC_VERIFY = IQorePQC(0x0000000000000000000000000000000000000a01);
    IQorePQC internal constant PQC_STATUS = IQorePQC(0x0000000000000000000000000000000000000a02);

    event Verified(address indexed caller, bool valid, uint256 gasUsed);

    function verify(bytes calldata pubkey, bytes calldata sig, bytes calldata message) external view returns (bool) {
        return PQC_VERIFY.pqcVerify(pubkey, sig, message);
    }

    /// State-changing variant: proves the call works inside a normal windowed tx and measures gas.
    function verifyAndLog(bytes calldata pubkey, bytes calldata sig, bytes calldata message) external returns (bool ok) {
        uint256 g = gasleft();
        ok = PQC_VERIFY.pqcVerify(pubkey, sig, message);
        emit Verified(msg.sender, ok, g - gasleft());
    }

    function status(address a) external view returns (bool registered, bool possessionProven, uint256 pubkeyLen) {
        (bool r,, bytes memory pk, bool p) = PQC_STATUS.pqcKeyStatus(a);
        return (r, p, pk.length);
    }
}
