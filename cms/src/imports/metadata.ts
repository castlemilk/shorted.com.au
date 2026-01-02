import dotenv from "dotenv";
import path from "path";
import csv from "csvtojson";
import * as fs from "fs";
import payload from "payload";
import { Metadata } from "../payload-types";
import buildConfig from "../payload.config";

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
      // .filter((source: Metadata) => source.stock_code === "SDV")
      .map((source: Metadata) => {
        return (async () => {
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
          if (result["docs"].length > 0) {
            console.log(`metadata for ${source.stock_code} already exists`);
            return;
          }
          const createPayload = {
            collection: "metadata",
            overrideAccess: true,
            locale: "en",
            showHiddenFields: false,
            // If creating verification-enabled auth doc,
            // you can optionally disable the email that is auto-sent
            disableVerificationEmail: true,
            data,
            filePath: null,
          };
          const imagePath = path.resolve(
            __dirname,
            `../../../analysis/data/images/${
              isNumeric(source.stock_code.at(0))
                ? "NUM"
                : source.stock_code.at(0).toUpperCase()
            }/${source.stock_code}/${source.stock_code}.png`
          );
          if (
            source.company_logo_link &&
            source.company_logo_link != "Not Found"
          ) {
            if (fs.existsSync(imagePath)) {
              createPayload.filePath = imagePath;
            } else {
              fs.copyFileSync(
                path.resolve(
                  __dirname,
                  `../../../analysis/data/images/asx-header-logo.png`
                ),
                imagePath
              );
              createPayload.filePath = imagePath;
            }
          }

          if (!createPayload.filePath) {
            fs.copyFileSync(
              path.resolve(
                __dirname,
                `../../../analysis/data/images/asx-header-logo.png`
              ),
              imagePath
            );
            createPayload.filePath = imagePath;
          }

          try {
            const resp = await payload.create(createPayload);
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
