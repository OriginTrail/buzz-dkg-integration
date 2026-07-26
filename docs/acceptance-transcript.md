# Gate C acceptance demo transcript

Started 2026-07-26T09:50:13.835Z. Real daemon, real isolated stacks, no mocks.

## 1. Channel setup

channel 'dkg-daemon-demo3' uuid=f10a752a-c17d-4102-8688-6c900736daf0
add member: accepted=true
add service: accepted=true
add promoter: accepted=true
bindings.json: channel → devnet-test, promoter=fc11ee8605a0…

## 2. Daemon start (publishMode=devnet, isolated chain check)

daemon started: "message":"dkg node","version":"10.0.9","chainId":"evm:31337","publishMode":"devnet"}

## 3. Signal a single-decision thread → one verified SWM receipt

thread root=935032621f25f2682bcab83e649181f20fbd060d224b59f5ccd0e6ea7da431b7
pin accepted=true id=7c7ca36e82789928b120dfc1d8b5d094cf06c8f6fe8dbc57210b97a7a220fbdf
SWM receipt (2accf34b3fcfb57130715d3be2fc0ab0d92fcab6e74fcfc4fb9ff6d1ae91876a):
```
Distilled to Shared Working Memory.
assertion: did:dkg:context-graph:devnet-test/assertion/0x71Cfc9B0fef62D15b5Fb6a6D6De7921231C0e91d/buzz-dkg-3b16f94a5441
ka: buzz-dkg-3b16f94a5441
context-graph: devnet-test
source-digest: sha256:3b16f94a5441dc8a766d99f0dca10df931a1c20a3f0753d28fefa095b64b0172
trigger: 7c7ca36e82789928b120dfc1d8b5d094cf06c8f6fe8dbc57210b97a7a220fbdf
status: SWM (not published to Verifiable Memory)
```

## 4. Daemon restart → catch-up replay → no duplicate receipt

after restart + catch-up: still exactly 1 receipt ✔ (cursor resume: "message":"catch-up","since":1785059354,"events":5})

## 5. Authorized ✅ approval → devnet VM publish → VM receipt

promoter ✅ accepted=true id=23d6411162a2c21e27fb9f44273a0023f7c3195a2fb7924c95c76babc2fac0d0
VM receipt (14721f163cefb96865ed2016be47ac465814387d5ed4ee7b2fdb7002eb256b69):
```
Published to Verifiable Memory.
UAL: did:dkg:evm:31337/0x71cfc9b0fef62d15b5fb6a6d6de7921231c0e91d/7
ka: buzz-dkg-3b16f94a5441
context-graph: devnet-test
source-digest: sha256:3b16f94a5441dc8a766d99f0dca10df931a1c20a3f0753d28fefa095b64b0172
approved-by: fc11ee8605a0bca53185867f1982334c61dd9249c752ab2532c07312acc294d6
approval-event: 23d6411162a2c21e27fb9f44273a0023f7c3195a2fb7924c95c76babc2fac0d0
```
unauthorized ✅ by non-promoter (edbcabe25463…): correctly no effect ✔

## 6. Grounded answering

Q: what did we decide about relay auth for service bots?
```
"DECISION: service bots must support both NIP-42 and NIP-98." [1]

Evidence (context-graph-scoped):
[1] urn:buzz-dkg:decision:0f4ee1e26eb39528c2a2b4ad78875cebf4d7be41e4c56c4770940ff977ee0cec
[2] urn:buzz-dkg:decision:270d5f70f2c9f8adceab29b9122b205c409c0698c1f6a0feeb29be687fb7331b
[3] urn:buzz-dkg:decision:adc8e91bc259a767b99940ed75c561b080f3c5fe71ee7a44cb6cef8c0e342d75
```
Q: who won the 1998 world cup final?
```
I can't answer that from this room's knowledge. No supporting evidence was found in context graph 'devnet-test', and I only answer from this room's designated context graph.
```

## 7. Final restart → cursor/resume proof

service replies to the thread after final restart: 2 (1 SWM receipt + 1 VM receipt) — unchanged ✔

**Acceptance demo complete.** UAL: `did:dkg:evm:31337/0x71cfc9b0fef62d15b5fb6a6d6de7921231c0e91d/7`

Finished 2026-07-26T09:50:31.488Z.
