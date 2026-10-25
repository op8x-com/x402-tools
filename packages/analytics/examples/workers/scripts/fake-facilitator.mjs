// Local fake x402 facilitator for the example: answers /supported, /verify and /settle.
// It moves no money and checks nothing. Never use it outside local development.
import http from "node:http";

const PORT = Number(process.env.PORT ?? 4021);
const PAYER = "0x2222222222222222222222222222222222222222";
const supported = {
  kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }],
  extensions: [],
  signers: {},
};

http
  .createServer(async (req, res) => {
    for await (const _ of req) {
      // drain the request body
    }
    console.log(req.method, req.url);
    res.setHeader("content-type", "application/json");
    if (req.url === "/supported") return res.end(JSON.stringify(supported));
    if (req.url === "/verify") return res.end(JSON.stringify({ isValid: true, payer: PAYER }));
    if (req.url === "/settle") {
      return res.end(JSON.stringify({ success: true, transaction: "0xabc", network: "eip155:84532", payer: PAYER }));
    }
    res.statusCode = 404;
    res.end("{}");
  })
  .listen(PORT, "127.0.0.1", () => console.log(`fake facilitator ready on http://127.0.0.1:${PORT}`));
