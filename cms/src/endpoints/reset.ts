import fs from "fs";
import path from "path";
import payload from "payload";

const collections = ["metadata", "media"];
const globals = [];

export const clearDB = async (): Promise<void> => {
  payload.logger.info(`— Clearing media...`);

  const mediaDir = path.resolve(__dirname, "../media");
  if (fs.existsSync(mediaDir)) {
    fs.rmSync(path.resolve(__dirname, "../media"), { recursive: true });
  }
  const logoDir = path.resolve(__dirname, "../metadata");
  if (fs.existsSync(mediaDir)) {
    fs.rmSync(path.resolve(__dirname, "../metadata"), { recursive: true });
  }

  payload.logger.info(`— Clearing collections and globals...`);
  await Promise.all([
    ...collections.map(async (collection) => {
      try {
        await payload.delete({
          collection: collection as "media",
          where: {},
        });
      } catch (error: unknown) {
        console.error(`Error deleting collection ${collection}:`, error); // eslint-disable-line no-console
        throw error;
      }
    }),
    ...globals.map(async (global) => {
      try {
        await payload.updateGlobal({
          data: {},
          slug: global as "header",
        });
      } catch (error: unknown) {
        console.error(`Error updating global ${global}:`, error); // eslint-disable-line no-console
        throw error;
      }
    }),
  ]);
};
