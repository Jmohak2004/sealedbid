// Local test chain: an in-process EVM (ganache) with a mock of the QoreChain PQC precompiles.
// Used by the test-suite and the offline demo. NEVER used against testnet.
import { readFileSync } from "node:fs";
import ganache from "ganache";
import {
  createPublicClient, createWalletClient, custom, parseEther, bytesToHex,
  type Address, type Hex, type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { generatePqcKeypair, type PqcKeypair } from "@qorechain/sdk";
import { generateSealKeys, type SealKeyPair } from "@qorechain/qoreseal";
import auctionArtifact from "./generated/SealedBidAuction.json" with { type: "json" };

export const LOCAL_CHAIN_ID = 1337;
export const SEAL_CHAIN_ID = "qorechain-diana"; // domain-separation string only; no network involved

export interface Participant {
  name: string;
  privateKey: Hex;
  account: PrivateKeyAccount;
  pq: PqcKeypair;
  seal: SealKeyPair;
}

export function newParticipant(name: string): Participant {
  const privateKey = generatePrivateKey();
  return { name, privateKey, account: privateKeyToAccount(privateKey), pq: generatePqcKeypair(), seal: generateSealKeys() };
}

export async function startLocalChain(participants: Participant[]) {
  const provider = ganache.provider({
    logging: { quiet: true },
    chain: { chainId: LOCAL_CHAIN_ID, networkId: LOCAL_CHAIN_ID, hardfork: "shanghai", vmErrorsOnRPCResponse: true },
    miner: { blockGasLimit: 60_000_000 },
    wallet: {
      accounts: participants.map((p) => ({ secretKey: p.privateKey, balance: "0x" + parseEther("1000").toString(16) })),
    },
  } as any);
  const transport = custom({ request: (args: any) => provider.request(args) });
  const chain = {
    id: LOCAL_CHAIN_ID, name: "local", nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
    rpcUrls: { default: { http: ["http://local"] } },
  } as const;
  const publicClient: PublicClient = createPublicClient({ chain, transport });
  const walletFor = (p: Participant) => createWalletClient({ chain, transport, account: p.account });

  // deploy the mock precompile + the auction pointing at it
  const mockArt = JSON.parse(readFileSync(new URL("../../build/MockPQC.json", import.meta.url), "utf8"));
  const deployer = participants[0];
  const dep = async (abi: any, bytecode: Hex, args: unknown[] = []) => {
    const hash = await walletFor(deployer).deployContract({ abi, bytecode, args, gas: 6_000_000n });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    return r.contractAddress as Address;
  };
  const mock = await dep(mockArt.abi, mockArt.bytecode);
  const auction = await dep(auctionArtifact.abi, auctionArtifact.bytecode as Hex, [mock, mock]);

  const increaseTime = async (secs: number) => {
    await provider.request({ method: "evm_increaseTime", params: [secs] } as any);
    await provider.request({ method: "evm_mine", params: [] } as any);
  };
  return { provider, publicClient, walletFor, mock, mockAbi: mockArt.abi, auction, auctionAbi: auctionArtifact.abi, increaseTime };
}

export type LocalChain = Awaited<ReturnType<typeof startLocalChain>>;

/** Register a participant's ML-DSA key in the mock registry (the real chain does this with MsgRegisterPQCKeyV2). */
export async function registerPq(chain: LocalChain, who: Participant, deployer: Participant, proven = true) {
  const hash = await chain.walletFor(deployer).writeContract({
    address: chain.mock, abi: chain.mockAbi, functionName: "setKey",
    args: [who.account.address, bytesToHex(who.pq.publicKey), proven],
  });
  await chain.publicClient.waitForTransactionReceipt({ hash });
}

/**
 * The mock cannot verify ML-DSA itself. The harness verifies the real signature with the SDK, then whitelists the
 * exact (pubkey, signature, message) triple, so the contract sees the same call shape as the real precompile.
 */
export async function allowSignature(
  chain: LocalChain, deployer: Participant, pubkey: Uint8Array, message: Uint8Array, signature: Hex,
) {
  const hash = await chain.walletFor(deployer).writeContract({
    address: chain.mock, abi: chain.mockAbi, functionName: "allow",
    args: [bytesToHex(pubkey), signature, bytesToHex(message)],
  });
  await chain.publicClient.waitForTransactionReceipt({ hash });
}
