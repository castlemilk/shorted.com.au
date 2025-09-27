import axios from "axios";
import * as fs from "fs";
import { SingleBar, Presets } from "cli-progress";

import * as path from "path";
import { exit } from "process";
const scriptDir = path.resolve();
const DATA_FOLDER = path.join(scriptDir, "notebooks/data");
const DATA_URL =
  "https://download.asic.gov.au/short-selling/short-selling-data.json";
const BASE_URL = "https://download.asic.gov.au/short-selling/";

// Ensure data directory exists
if (!fs.existsSync(DATA_FOLDER)) {
  fs.mkdirSync(DATA_FOLDER, { recursive: true });
}

interface ShortSellingRecord {
  date: number;
  version: string;
}

// Initialize progress bar
const progressBar = new SingleBar({}, Presets.shades_classic);

// Helper function to generate download URLs
export const generateDownloadUrl = (record: ShortSellingRecord): string => {
  const dateStr = record.date.toString();
  const year = dateStr.substr(0, 4);
  const month = dateStr.substr(4, 2);
  const day = dateStr.substr(6, 2);
  return `${BASE_URL}RR${year}${month}${day}-${record.version}-SSDailyAggShortPos.csv`;
};

// Check if file already downloaded
const isDownloaded = (fileName: string): boolean => {
  return fs.existsSync(path.join(DATA_FOLDER, fileName));
};

// Download file function with progress bar update
const downloadFile = async (url: string, fileName: string) => {
  if (isDownloaded(fileName)) {
    // console.log(`File ${fileName} already downloaded.`);
    progressBar.increment();
    return;
  }

  try {
    const response = await axios.get(url, { responseType: "stream" });

    const filePath = path.join(DATA_FOLDER, fileName);
    response.data.pipe(fs.createWriteStream(filePath));
    response.data.on("close", () => {
      //   console.log(`Downloaded file ${fileName}`);
      progressBar.increment();
      return;
    });
  } catch (error) {
    // console.error(`Error downloading file ${fileName}:`, error);
    progressBar.increment();
    return;
  }
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Main function to fetch data and manage downloads with progress bar
export const fetchDataAndDownload = async () => {
  let count = 0;
  try {
    const { data } = await axios.get<ShortSellingRecord[]>(DATA_URL);
    progressBar.start(data.length, 0);

    // Limit concurrent downloads
    const concurrentDownloads = data.map((record) => {
      const url = generateDownloadUrl(record);
      const fileName = url.substring(url.lastIndexOf("/") + 1);
      return () => downloadFile(url, fileName);
    });

    const MAX_CONCURRENT = 5;
    for (let i = 0; i < concurrentDownloads.length; i += MAX_CONCURRENT) {
      await Promise.all(
        concurrentDownloads.slice(i, i + MAX_CONCURRENT).map((fn) => {
          fn();
          count += 1;
          sleep(50);
        }),
      );
    }

    progressBar.stop();
    console.log("Finished downloading data.");
    return count;
  } catch (error) {
    console.error("Failed to fetch short selling data:", error);
    progressBar.stop();
    return count;
  }
};

// Run the main function only if this file is executed directly
if (require.main === module) {
  fetchDataAndDownload();
  exit(0);
}
