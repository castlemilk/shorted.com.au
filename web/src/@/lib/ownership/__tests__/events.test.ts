import { NOTICE_EVENT_LABELS, noticeEventLabel } from "../events";
import { NOTICE_EVENTS } from "../query";

describe("notice event labels", () => {
  it("has a label for every event the API sends", () => {
    expect(Object.keys(NOTICE_EVENT_LABELS).sort()).toEqual([...NOTICE_EVENTS].sort());
  });

  it("uses the label table's words for each event", () => {
    expect(NOTICE_EVENT_LABELS).toEqual({
      became: "Became substantial",
      increased: "Increased",
      decreased: "Decreased",
      changed: "Changed",
      ceased: "Ceased",
      nz: "NZ disclosure",
    });
  });

  it("prints each label in sentence case, with NZ the one acronym", () => {
    for (const label of Object.values(NOTICE_EVENT_LABELS)) {
      expect(label).toMatch(/^(NZ|[A-Z][a-z]+)( [a-z]+)*$/);
    }
  });

  it("reads the event the API sent and prints its label", () => {
    expect(noticeEventLabel("became")).toBe("Became substantial");
    expect(noticeEventLabel("nz")).toBe("NZ disclosure");
  });

  it("prints n/a for an event the API did not send", () => {
    expect(noticeEventLabel("")).toBe("n/a");
  });

  it("prints an event this build does not know as the API sent it", () => {
    expect(noticeEventLabel("withdrawn")).toBe("withdrawn");
  });

  it("keeps the copy free of em dashes", () => {
    const emDash = String.fromCharCode(0x2014);
    const copy = Object.values(NOTICE_EVENT_LABELS);
    expect(copy.filter((text) => text.includes(emDash))).toEqual([]);
  });
});
