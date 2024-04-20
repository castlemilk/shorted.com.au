import type { CollectionConfig } from "payload/types";

import path from "path";

export const Media: CollectionConfig = {
  access: {
    create: () => true,
    delete: () => true,
    read: () => true,
    update: () => true,
  },
  admin: {
    description: "media files",
  },
  fields: [
    {
      name: "alt",
      required: true,
      type: "text",
    },
  ],
  slug: "media",
  upload: true,
};
