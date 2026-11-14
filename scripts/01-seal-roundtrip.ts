// Spike 1: QoreSeal offline round trip (no network, no funds).
import { generateSealKeys, open, recipientOf, seal } from "@qorechain/qoreseal";

const chainId = "qorechain-diana";
const purpose = "sealedbid/bid/v1";
const auctioneer = generateSealKeys();
const msg = JSON.stringify({ auctionId: 1, amount: "125000", salt: "0xdeadbeef" });

const envelope = seal({
  chainId, purpose,
  recipients: [recipientOf(auctioneer)],
  plaintext: new TextEncoder().encode(msg),
});
console.log("envelope bytes:", envelope.length);

const back = open({ chainId, purpose, envelope, keys: auctioneer });
const text = new TextDecoder().decode(back as Uint8Array);
console.log("decrypted OK:", text === msg);

// Negative: a different party must not be able to open it
try {
  open({ chainId, purpose, envelope, keys: generateSealKeys() });
  console.log("FAIL: stranger could open");
} catch (e) { console.log("stranger rejected OK:", (e as Error).message.slice(0, 60)); }
