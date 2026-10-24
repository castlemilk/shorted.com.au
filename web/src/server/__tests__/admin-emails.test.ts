import { parseAdminEmails } from "../admin-emails";

describe("parseAdminEmails", () => {
  it("reads a comma list, trimmed and lower-cased", () => {
    expect(parseAdminEmails(" Ben@Shorted.com.au , other@example.com ")).toEqual([
      "ben@shorted.com.au",
      "other@example.com",
    ]);
  });

  // Prod's value ended in a literal backslash-n, which hid its last address.
  it("drops a literal escaped-newline suffix", () => {
    expect(parseAdminEmails("ben.ebsworth@gmail.com,ben@shorted.com.au\\n")).toEqual([
      "ben.ebsworth@gmail.com",
      "ben@shorted.com.au",
    ]);
  });

  it("treats escaped or real newlines and spaces between entries as separators", () => {
    expect(parseAdminEmails("a@x.com\\nb@x.com\nc@x.com d@x.com\\r")).toEqual([
      "a@x.com",
      "b@x.com",
      "c@x.com",
      "d@x.com",
    ]);
  });

  it("is empty for an unset or blank value", () => {
    expect(parseAdminEmails(undefined)).toEqual([]);
    expect(parseAdminEmails(" , \\n ")).toEqual([]);
  });
});
