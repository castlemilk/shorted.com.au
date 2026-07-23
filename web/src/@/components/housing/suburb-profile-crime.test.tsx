import { create } from "@bufbuild/protobuf";
import { render, screen } from "@testing-library/react";
import {
  SuburbCrimeSchema,
  SuburbCrimeStatSchema,
} from "~/gen/shorts/v1alpha1/housing_pb";
import { CrimeCard } from "./suburb-profile";

const crime = create(SuburbCrimeSchema, {
  sourceJurisdiction: "NSW",
  source: "bocsar",
  sourceLicence: "CC-BY-4.0",
  stats: [
    create(SuburbCrimeStatSchema, {
      crimeType: "break_ins",
      ratePer100k: 0,
      pctRank: 72,
      fyEnding: 2025,
    }),
    create(SuburbCrimeStatSchema, {
      crimeType: "violent",
      ratePer100k: 1234.5,
      pctRank: 43,
      fyEnding: 2025,
    }),
    create(SuburbCrimeStatSchema, {
      crimeType: "motor_vehicle",
      ratePer100k: 845.2,
      pctRank: 88,
      fyEnding: 2025,
    }),
  ],
});

test("renders reliable crime rates, percentiles, FY and mandatory CC-BY attribution", () => {
  const { container } = render(<CrimeCard crime={crime} />);

  expect(screen.getByRole("heading", { name: /crime & safety/i })).toBeInTheDocument();
  expect(screen.getByText("Break-ins")).toBeInTheDocument();
  expect(screen.getByText("Violent crime")).toBeInTheDocument();
  expect(screen.getByText("Car theft")).toBeInTheDocument();
  expect(container).toHaveTextContent("0/100k");
  expect(container).toHaveTextContent("1,235/100k");
  expect(container).toHaveTextContent("72nd percentile");
  expect(container).toHaveTextContent("FY2024–25");
  expect(container).toHaveTextContent("NSW Bureau of Crime Statistics and Research (BOCSAR)");
  expect(container).toHaveTextContent("ABS Crime Victimisation Survey");
  expect(container).toHaveTextContent("ABS ERP");
  expect(container).toHaveTextContent("CC BY 4.0");
});

test("renders nothing when the suburb has no reliable crime data", () => {
  const { container } = render(<CrimeCard crime={undefined} />);
  expect(container).toBeEmptyDOMElement();
});
