import axios from "axios";
import fs from "fs";
import * as script from "./sync-short-data"; // Update the import path as necessary
import path from "path";
import { when } from "jest-when";
import stream from "stream";
// Mock data
const mockData = [
  { date: 20240129, version: "001" },
  { date: 20230214, version: "010" },
  { date: 20180212, version: "002" },
  { date: 20200116, version: "001" },
];

jest.mock("axios");
jest.mock("fs");

describe("fetchDataAndDownload", () => {
  beforeAll(() => {
    // Mock axios.get to resolve with mockData
    (axios.get as jest.Mock).mockImplementation(() =>
      Promise.resolve({ data: mockData }),
    );
    // Mock fs.existsSync to prevent file system errors during tests
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    // Mock fs.createWriteStream to simulate file download without errors
    (fs.createWriteStream as jest.Mock).mockReturnValue({
      on: (event: string, callback: () => void) => {
        if (event === "close") callback();
      },
    });
    // Mock fs.existsSync to simulate that a file exists if its name includes certain dates
    (fs.existsSync as jest.Mock).mockImplementation(
      (filePath: string) =>
        filePath.includes("20240129") || filePath.includes("20230214"),
    );

    // Mock fs.createWriteStream to simulate file download without errors
    const mockStream = new stream.Writable({
      write(chunk, encoding, callback) {
        callback();
      },
    });
    (fs.createWriteStream as jest.Mock).mockReturnValue(mockStream);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("should fetch data and generate correct download URLs", async () => {
    // Assuming fetchDataAndDownload is an async function you would call
    await script.fetchDataAndDownload();

    // Verify axios.get was called correctly
    expect(axios.get).toHaveBeenCalledWith(
      "https://download.asic.gov.au/short-selling/short-selling-data.json",
    );

    // Verify URLs are generated correctly based on mockData
    const expectedUrls = mockData.map(
      (data) => script.generateDownloadUrl(data), // Assuming generateDownloadUrl is now correctly exported and used here
    );
    expect(expectedUrls).toEqual([
      "https://download.asic.gov.au/short-selling/RR20240129-001-SSDailyAggShortPos.csv",
      "https://download.asic.gov.au/short-selling/RR20230214-010-SSDailyAggShortPos.csv",
      "https://download.asic.gov.au/short-selling/RR20180212-002-SSDailyAggShortPos.csv",
      "https://download.asic.gov.au/short-selling/RR20200116-001-SSDailyAggShortPos.csv",
    ]);
  });

  it("checks if files already exist and manages concurrency", async () => {
    (axios.get as jest.Mock).mockImplementationOnce(() =>
      Promise.resolve({ data: mockData }),
    );
    // Reset mock for fs.existsSync to simulate some files existing
    (fs.existsSync as jest.Mock).mockImplementation((path: string) =>
      path.includes("20240129"),
    );
    when(axios.get)
      //   .calledWith(expect.stringContaining("2024"), { responseType: "stream" })
      .mockImplementation(() => {
        const readable = new stream.Readable();
        readable._read = () => {}; // No-op
        readable.push("some-csv-data...");
        readable.push(null); // End of stream

        return Promise.resolve({ data: readable });
      });
    // // Call your method here
    const downloadedFiles = await script.fetchDataAndDownload();

    expect(downloadedFiles).toEqual(4);
    expect(axios.get).toHaveBeenCalledTimes(4);
  });

  it("handles errors during data fetching", async () => {
    // Mock axios.get to reject with an error
    (axios.get as jest.Mock).mockRejectedValue(new Error("Network error"));

    await expect(script.fetchDataAndDownload()).resolves.toEqual(0);
    // Additional checks for error logging or cleanup can be added here
  });

  // Reset mocks after all tests in this suite
  afterAll(() => {
    jest.clearAllMocks();
  });
});
