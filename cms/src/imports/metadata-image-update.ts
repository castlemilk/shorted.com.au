import dotenv from "dotenv";
import fs from "fs/promises"; // Using promises for async/await support
import path from "path";
import csv from "csvtojson";
import payload from "payload";
import sharp from "sharp"; // For image conversion
import { Metadata } from "../payload-types";
import buildConfig from "../payload.config";
import { res } from "pino-std-serializers";

function isNumeric(n) {
  return !isNaN(parseFloat(n)) && isFinite(n);
}

dotenv.config();
payload.init({
  config: buildConfig,
  secret: process.env.PAYLOAD_SECRET,
  local: true,
  onInit: async () => {
    const metadataSource: { [key: string]: Metadata } = {};
    const csvPath = path.resolve(
      __dirname,
      "../../../analysis/data/asx_company_metadata_final.csv"
    );
    const fromCSV: Metadata[] = await csv().fromFile(csvPath);

    const creationPromises = fromCSV
    //   .filter((source: Metadata) => source.stock_code === "SYR")
      .map((source: Metadata) => {
        return (async () => {
          const directoryPath = path.resolve(
            __dirname,
            `../../../analysis/data/asx-company-images/companies/${
              isNumeric(source.stock_code.at(0))
                ? "NUM"
                : source.stock_code.at(0).toUpperCase()
            }/${source.stock_code}/`
          );
          var files = [];
          try {
            files = await fs.readdir(directoryPath);
          } catch (e) {
            return;
          }
          const imageFiles = files.filter(
            (file) => file.endsWith(".png") || file.endsWith(".svg")
          );
          if (imageFiles.length === 0) {
            console.log(
              `No PNG or SVG files found for ${source.stock_code}. Skipping.`
            );
            return;
          }

          let imagePath = path.join(directoryPath, imageFiles[0]); // Default to the first file found
          if (imageFiles[0].endsWith(".svg")) {
            const newFileName = `${source.stock_code}.png`;
            const outputPath = path.join(directoryPath, newFileName);
            await sharp(imagePath).png().toFile(outputPath);
            imagePath = outputPath;
          } else {
            const newPngFileName = `${source.stock_code}.png`;
            const newFilePath = path.join(directoryPath, newPngFileName);
            // Rename the file
            await fs.rename(imagePath, newFilePath);
          }

          const data: Omit<Metadata, "id" | "createdAt" | "updatedAt"> = {
            stock_code: source.stock_code,
            company_name: source.company_name,
            market_cap: source.market_cap,
            industry: source.industry,
            listing_date: source.listing_date,
            details: source.details,
            summary: source.summary,
            address: source.address,
            website: source.website,
            links: source.links,
            images: source.images,
            company_logo_link: source.company_logo_link,
            // other fields you might have
          };
          // eslint-disable-next-line no-await-in-loop
          const result = await payload.find({
            collection: "metadata", // required
            page: 1,
            limit: 1,
            where: {
              stock_code: { equals: source.stock_code }, // pass a `where` query here
            },
          });
          if (result["docs"].length === 0) {
            console.log("No existing metadata found for:", source.stock_code);
            return;
          }
          const updatePayload = {
            collection: "metadata",
            id: result["docs"][0]["id"],
            overwriteExistingFiles: true,
            data: {},
          };

          updatePayload.filePath = imagePath ? imagePath : null;

          if (imagePath === null) {
            console.log("no image found for:", source.stock_code);
            return;
          }

          try {
            const resp = await payload.update(updatePayload);
            console.log("created: ", resp);
            return resp;
          } catch (e) {
            console.log("Failed to create payload for data:", source);
            console.error(
              "Failed to create payload for:",
              source.stock_code,
              e
            );
            // return a special value or throw to signal failure
            throw e;
          }
        })();
      });
    Promise.allSettled(creationPromises).then((results) => {
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          console.log("Payload created for:", fromCSV[index].stock_code);
        } else {
          console.error(
            "Payload creation failed for:",
            fromCSV[index].stock_code,
            result.reason
          );
        }
      });
      process.exit(0);
    });
  },
});
