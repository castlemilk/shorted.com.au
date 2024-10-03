"use client";

import React, { useEffect, useState } from "react";
import { RedocStandalone } from "redoc";
import yaml from "js-yaml";

type OpenAPISpec = Record<string, unknown>;

const Page: React.FC = () => {
  const [data, setData] = useState(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const response = await fetch(
          `${
            process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ??
            "http://localhost:8080"
          }/api/docs/openapi.yaml`,
        );
        const yamlText = await response.text();
        const openapiSpec = yaml.load(yamlText) as OpenAPISpec;
        setData(openapiSpec);
      } catch (error) {
        console.error("Error fetching or parsing OpenAPI spec:", error);
      }
    };

    fetchData();
  }, []);

  return data ? <RedocStandalone spec={data} /> : <div>loading ...</div>;
};

export default Page;
