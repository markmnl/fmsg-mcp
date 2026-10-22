import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeFmsgServer, fakeHash } from "./fake-fmsg-server.js";
import { ALICE, BOB, CAROL, type Harness, call, connectInMemory, structured, text } from "./helpers.js";

/** Carol is added to Bob's reply after it was sent; she can reply to that message only, through her batch's hash. */
describe("replies from added recipients", () => {
  let fake: FakeFmsgServer;
  let carol: Harness;
  let root: ReturnType<FakeFmsgServer["seed"]>;
  let added: ReturnType<FakeFmsgServer["seed"]>;
  const batchHash = fakeHash("batch", "7000");

  beforeEach(async () => {
    fake = new FakeFmsgServer();
    await fake.start();
    carol = await connectInMemory(fake, "fmsgk_carol_secret");
    root = fake.seed({ from: ALICE, to: [BOB], topic: "Plans", data: "root" });
    added = fake.seed({ from: BOB, to: [ALICE], pid: root.id, data: "bob's reply" });
    added.add_to.push({ batch_id: "7000", add_to_from: BOB, to: [CAROL], to_delivery: [], time: 1 });
  });
  afterEach(async () => {
    await carol.close();
    await fake.stop();
  });

  const posted = () => fake.requests.filter((r) => r.method === "POST" && r.path === "/fmsg").map((r) => r.body as Record<string, unknown>);

  it("reply sends the batch hash as the parent", async () => {
    const r = await call(carol.client, "reply", { id: added.id, body: "thanks for adding me" });
    expect(text(r)).toContain(`Sent reply`);
    const sent = structured<{ id: string; parent_id: string; to: string[] }>(r);
    expect(sent.parent_id).toBe(added.id);
    expect(sent.to.sort()).toEqual([ALICE, BOB].sort());
    expect(posted().at(-1)!.pid).toBe(batchHash);
    expect(fake.messages.get(sent.id)).toMatchObject({ pid: added.id, psha256: batchHash });
  });

  it("create_draft replies through the batch hash, and send_draft sends it", async () => {
    const draft = structured<{ draft_id: string; parent_id: string }>(await call(carol.client, "create_draft", { reply_to: added.id, body: "draft reply" }));
    expect(draft.parent_id).toBe(added.id);
    expect(posted().at(-1)!.pid).toBe(batchHash);
    const sent = structured<{ id: string; parent_id: string; thread_topic: string | null }>(await call(carol.client, "send_draft", { id: draft.draft_id }));
    expect(sent).toMatchObject({ id: draft.draft_id, parent_id: added.id });
    expect(fake.messages.get(draft.draft_id)).toMatchObject({ pid: added.id, psha256: batchHash });
    expect(fake.messages.get(draft.draft_id)!.time).not.toBeNull();
  });

  it("names the message an added recipient can reply to when they reply higher up the thread", async () => {
    for (const [tool, args] of [["reply", { id: root.id, body: "x" }], ["create_draft", { reply_to: root.id, body: "x" }]] as const) {
      const r = await call(carol.client, tool, args);
      expect(r.isError).toBe(true);
      expect(text(r)).toContain(`You cannot reply to message ${root.id}: you are not a participant of it.`);
      expect(text(r)).toContain(`You were added to message ${added.id}`);
      expect(text(r)).toContain(`pass id ${added.id}`);
    }
    expect(posted()).toEqual([]);
  });

  it("names the message to reply to when the host answers 403 access denied, as fmsg-webapi does", async () => {
    fake.failNext = { match: new RegExp(`^GET /fmsg/${root.id}$`, "u"), status: 403, error: "access denied" };
    const r = await call(carol.client, "reply", { id: root.id, body: "x" });
    expect(text(r)).toContain(`You were added to message ${added.id}`);
  });

  it("keeps the host's error when the message is not in a thread the caller was added to", async () => {
    const other = fake.seed({ from: ALICE, to: [BOB], topic: "Private", data: "not for carol" });
    const r = await call(carol.client, "reply", { id: other.id, body: "x" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("not found (HTTP 404)");
    expect(text(r)).not.toContain("You were added to");
  });

  it("sends the numeric parent id for the sender and primary recipients", async () => {
    const bob = await connectInMemory(fake, "fmsgk_bob_secret");
    try {
      structured(await call(bob.client, "reply", { id: added.id, body: "mine" }));
      expect(posted().at(-1)!.pid).toBe(Number(added.id));
      structured(await call(bob.client, "reply", { id: root.id, body: "a recipient" }));
      expect(posted().at(-1)!.pid).toBe(Number(root.id));
    } finally {
      await bob.close();
    }
  });

  it("falls back to the numeric id on a host that gives no batch hash", async () => {
    added.add_to[0]!.sha256 = null;
    await call(carol.client, "reply", { id: added.id, body: "x" });
    expect(posted().at(-1)!.pid).toBe(Number(added.id));
  });
});
