// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// TEST ONLY. Stands in for the QoreChain PQC precompiles (0x0a01 / 0x0a02) on a local chain.
/// The test harness checks the real ML-DSA-87 signature off-chain and then whitelists the exact
/// (pubkey, signature, message) triple here, so the contract under test sees the same call shape
/// as on testnet. It does NOT prove the precompile's real behaviour: that is what scripts/02 is for.
contract MockPQC {
    mapping(bytes32 => bool) public okTriple;
    struct Key { bool registered; bool proven; bytes pubkey; }
    mapping(address => Key) internal keys;

    function setKey(address a, bytes calldata pubkey, bool proven) external {
        keys[a] = Key(true, proven, pubkey);
    }
    function allow(bytes calldata pubkey, bytes calldata sig, bytes calldata message) external {
        okTriple[keccak256(abi.encode(pubkey, sig, message))] = true;
    }
    function pqcVerify(bytes calldata pubkey, bytes calldata sig, bytes calldata message) external view returns (bool) {
        return okTriple[keccak256(abi.encode(pubkey, sig, message))];
    }
    function pqcKeyStatus(address a) external view returns (bool, uint8, bytes memory, bool) {
        Key storage k = keys[a];
        return (k.registered, k.registered ? 1 : 0, k.pubkey, k.proven);
    }
}
