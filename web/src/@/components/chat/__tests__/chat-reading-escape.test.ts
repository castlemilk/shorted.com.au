import { escapeClearsReading } from "../chat-reading-escape";

describe("escapeClearsReading", () => {
  it("takes the Escape while a chart or sparkline shows a reading", () => {
    const chart = document.createElement("div");
    chart.setAttribute("data-reading-active", "true");
    document.body.appendChild(chart);
    try {
      expect(escapeClearsReading(chart)).toBe(true);
    } finally {
      chart.remove();
    }
  });

  it("finds the reading from a focused element inside the chart", () => {
    const chart = document.createElement("div");
    chart.setAttribute("data-reading-active", "true");
    const inner = document.createElement("span");
    chart.appendChild(inner);
    document.body.appendChild(chart);
    try {
      expect(escapeClearsReading(inner)).toBe(true);
    } finally {
      chart.remove();
    }
  });

  it("lets the Escape close the sheet when no reading is shown", () => {
    const chart = document.createElement("div");
    chart.setAttribute("data-reading-active", "false");
    document.body.appendChild(chart);
    try {
      expect(escapeClearsReading(chart)).toBe(false);
      expect(escapeClearsReading(document.body)).toBe(false);
    } finally {
      chart.remove();
    }
  });

  it("is false for no target, and for a target that is not an element", () => {
    expect(escapeClearsReading(null)).toBe(false);
    expect(escapeClearsReading(document)).toBe(false);
  });
});
