import { render, screen } from "@testing-library/react";
import type { SubstantialNotice } from "~/gen/shorts/v1alpha1/ownership_pb";
import { noticeRow } from "~/@/lib/ownership/rows";
import { NoticeRowsTable } from "../ownership-tables";
import { MODEL_READ_TITLE, ModelReadMark } from "../notice-mark";

// A notice as the API serves it, with only the fields the row reads.
function notice(over: Partial<SubstantialNotice>): SubstantialNotice {
  return {
    stockCode: "ZIP",
    companyName: "Zip Co",
    holderKey: "jpmorgan",
    holderName: "JPMorgan Chase",
    institutionSlug: "jpmorgan",
    kind: "bank_broker",
    form: "604",
    presentPct: 6.1,
    hasPresent: true,
    previousPct: 5.2,
    hasPrevious: true,
    ceased: false,
    eventDate: "2026-10-14",
    announcedOn: "2026-10-16",
    announcementUrl: "https://www.asx.com.au/asxpdf/20261016/pdf/x.pdf",
    event: "increased",
    readBy: "parser",
    ...over,
  } as SubstantialNotice;
}

describe("the model-read mark", () => {
  it("is a small muted word with the title that says what a model's reading rests on", () => {
    render(<ModelReadMark />);
    const mark = screen.getByText("model-read");
    expect(mark).toHaveAttribute("title", MODEL_READ_TITLE);
    expect(MODEL_READ_TITLE).toBe("Read by a model, two readers agreed; validated against the share count");
    expect(mark.className).toContain("text-muted-foreground");
  });

  it("is carried by a model-read notice's row only, and never by a parser's", () => {
    expect(noticeRow(notice({ readBy: "model" }), true).readBy).toBe("model");
    expect(noticeRow(notice({ readBy: "parser" }), true).readBy).toBeUndefined();
    expect(noticeRow(notice({ readBy: "" }), true).readBy).toBeUndefined();
  });

  it("is drawn in the register's history table beside the form, for a model-read row only", () => {
    const rows = [
      noticeRow(notice({ readBy: "model" }), true),
      noticeRow(notice({ readBy: "parser", announcedOn: "2026-09-01" }), true),
    ];
    render(<NoticeRowsTable rows={rows} showStock={false} showHolder caption="ZIP's notices" />);
    expect(screen.getAllByText("model-read")).toHaveLength(1);
    expect(screen.getAllByText("model-read")[0].closest("td")).toHaveTextContent(`${rows[0].form}model-read`);
  });
});
