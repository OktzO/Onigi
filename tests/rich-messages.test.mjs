import { test } from "node:test";
import assert from "node:assert/strict";
import {
  prepareRichResponseMessage,
  tokenizeCode,
  LANGUAGE_KEYWORDS,
} from "../lib/Utils/rich-messages.js";
import { proto } from "../WAProto/index.js";
import { generateWAMessageContent } from "../lib/Utils/messages.js";

test("tokenizeCode: keyword bahasa baru terdaftar", () => {
  assert.ok(LANGUAGE_KEYWORDS.rust.has("fn"));
  assert.ok(LANGUAGE_KEYWORDS.cpp.has("constexpr"));
  assert.ok(LANGUAGE_KEYWORDS.css.has("important"));
  assert.ok(LANGUAGE_KEYWORDS["c#"] === undefined);
  assert.ok(LANGUAGE_KEYWORDS.csharp.has("foreach"));
  const blocks = tokenizeCode("fn main() {}", "rust");
  assert.ok(blocks.some((b) => b.codeContent === "fn"));
});

test("prepareRichResponseMessage: shortcut table", () => {
  const msg = prepareRichResponseMessage({
    title: "Judul",
    table: [
      ["a", "b"],
      ["1", "2"],
    ],
  });
  assert.ok(msg.botForwardedMessage?.message?.richResponseMessage);
  const rich = msg.botForwardedMessage.message.richResponseMessage;
  assert.equal(
    rich.messageType,
    proto.AIRichResponseMessageType.AI_RICH_RESPONSE_TYPE_STANDARD,
  );
  assert.equal(rich.submessages.length, 1);
  assert.equal(rich.submessages[0].tableMetadata.rows.length, 2);
  assert.equal(rich.submessages[0].tableMetadata.rows[0].isHeading, true);
  const unified = JSON.parse(rich.unifiedResponse.data.toString("utf-8"));
  assert.equal(unified.sections.length, 1);
  assert.equal(
    unified.sections[0].view_model.primitive.__typename,
    "GenATableUXPrimitive",
  );
  assert.ok(msg.messageContextInfo?.botMetadata?.botResponseId);
});

test("prepareRichResponseMessage: shortcut code", () => {
  const msg = prepareRichResponseMessage({
    headerText: "Contoh",
    code: "const x = 1; // hi",
    language: "javascript",
    footerText: "Bye",
  });
  const rich = msg.botForwardedMessage.message.richResponseMessage;
  assert.equal(rich.submessages.length, 3);
  const unified = JSON.parse(rich.unifiedResponse.data.toString("utf-8"));
  const codeSection = unified.sections.find(
    (s) => s.view_model.primitive.__typename === "GenAICodeUXPrimitive",
  );
  assert.ok(codeSection);
  assert.ok(
    codeSection.view_model.primitive.code_blocks.some(
      (b) => b.type === "KEYWORD",
    ),
  );
});

test("prepareRichResponseMessage: richResponse array submessage", () => {
  const msg = prepareRichResponseMessage({
    richResponse: [
      { text: "halo" },
      { table: [{ items: ["x"], isHeading: true }], title: "T" },
    ],
  });
  const rich = msg.botForwardedMessage.message.richResponseMessage;
  assert.equal(rich.submessages.length, 2);
  assert.equal(rich.submessages[0].messageType, 2);
  assert.equal(rich.submessages[1].messageType, 4);
});

test("generateWAMessageContent: shortcut { code } → botForwardedMessage", async () => {
  const m = await generateWAMessageContent(
    { code: "print('hi')", language: "python" },
    {},
  );
  assert.ok(m.botForwardedMessage?.message?.richResponseMessage);
});

test("generateWAMessageContent: raw boolean lolos apa adanya", async () => {
  const rawContent = {
    raw: true,
    someCustomMessage: { field: 1 },
  };
  const m = await generateWAMessageContent(rawContent, {});
  assert.deepEqual(m, { someCustomMessage: { field: 1 } });
});

test("generateWAMessageContent: viewOnceV2 wrapper", async () => {
  const m = await generateWAMessageContent(
    { text: "hi", viewOnceV2: true },
    {},
  );
  const outer = m.viewOnceMessageV2;
  assert.ok(outer);
  assert.ok(outer.message.extendedTextMessage);
});

test("generateWAMessageContent: spoiler wrapper", async () => {
  const m = await generateWAMessageContent(
    { text: "rahasia", spoiler: true },
    {},
  );
  assert.ok(m.spoilerMessage);
  assert.equal(
    m.spoilerMessage.message.extendedTextMessage.contextInfo.isSpoiler,
    true,
  );
});

test("generateWAMessageContent: externalAdReply langsung", async () => {
  const m = await generateWAMessageContent(
    {
      text: "cek",
      externalAdReply: {
        title: "Judul Iklan",
        body: "Keterangan",
        url: "https://example.com",
      },
    },
    {},
  );
  const ear = m.extendedTextMessage.contextInfo.externalAdReply;
  assert.equal(ear.title, "Judul Iklan");
  assert.equal(ear.sourceUrl, "https://example.com");
  assert.equal(ear.mediaType, 1);
});

test("generateWAMessageContent: table shortcut + table V1 (dugong) tidak konflik", async () => {
  const m = await generateWAMessageContent(
    { table: [["h1", "h2"], ["v1", "v2"]], title: "T" },
    {},
  );
  assert.ok(m.botForwardedMessage.message.richResponseMessage);
});

test("proto: botForwardedMessage roundtrip lewat Message.encode/decode", () => {
  const msg = prepareRichResponseMessage({ code: "let a = 1" });
  const outer = proto.Message.fromObject({
    botForwardedMessage: msg.botForwardedMessage,
  });
  const buf = proto.Message.encode(outer).finish();
  const dec = proto.Message.decode(buf);
  assert.ok(dec.botForwardedMessage.message.richResponseMessage);
});
