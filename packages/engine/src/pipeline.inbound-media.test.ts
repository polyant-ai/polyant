// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A photo sent with no caption arrives as an empty text plus an attachment.
 * When the agent did not store the file, the user row kept nothing of it: the
 * conversation showed an empty bubble, and the title was generated from an
 * empty user line.
 */

import { describe, it, expect } from "vitest";
import { inboundMetadataOf, titleUserLine } from "./pipeline.js";

describe("inboundMetadataOf", () => {
  it("records the kinds of the attachments next to the channel metadata", () => {
    expect(
      inboundMetadataOf({ metadata: { messageSid: "SM1" }, attachments: [{ type: "image" }, { type: "file" }] }),
    ).toEqual({ messageSid: "SM1", attachmentKinds: ["image", "file"] });
  });

  it("stays absent for a text message with no metadata", () => {
    expect(inboundMetadataOf({ metadata: {} })).toBeUndefined();
    expect(inboundMetadataOf({ metadata: {}, attachments: [] })).toBeUndefined();
  });
});

describe("titleUserLine", () => {
  it("names the attachments, so a photo with no caption still has a user line", () => {
    expect(titleUserLine("", [{ type: "image" }, { type: "image" }])).toBe("User: [attached: image, image]");
    expect(titleUserLine("look", [{ type: "image" }])).toBe("User: look [attached: image]");
  });

  it("is the text alone when nothing was attached", () => {
    expect(titleUserLine("hello", undefined)).toBe("User: hello");
  });
});
