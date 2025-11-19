import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { KeyPeople } from "../key-people";
import type { Person } from "~/@/types/company-metadata";

const mockPeople: Person[] = [
  {
    name: "Rob Scott",
    role: "Managing Director & CEO",
    bio: "Joined Wesfarmers in 1993 and has held senior roles across the business.",
  },
  {
    name: "Anthony Gianotti",
    role: "Chief Financial Officer",
    bio: "Joined Wesfarmers in 2004 and has extensive experience in finance.",
  },
];

describe("KeyPeople", () => {
  it("should render key people section with all information", () => {
    render(<KeyPeople people={mockPeople} companyName="Wesfarmers" />);

    expect(screen.getByText("Key People")).toBeInTheDocument();
    expect(screen.getByText(/Leadership team at Wesfarmers/i)).toBeInTheDocument();

    // Check CEO
    expect(screen.getByText("Rob Scott")).toBeInTheDocument();
    expect(screen.getByText("Managing Director & CEO")).toBeInTheDocument();
    expect(screen.getByText(/Joined Wesfarmers in 1993/i)).toBeInTheDocument();

    // Check CFO
    expect(screen.getByText("Anthony Gianotti")).toBeInTheDocument();
    expect(screen.getByText("Chief Financial Officer")).toBeInTheDocument();
    expect(screen.getByText(/extensive experience in finance/i)).toBeInTheDocument();
  });

  it("should render initials avatars for each person", () => {
    render(<KeyPeople people={mockPeople} companyName="Wesfarmers" />);

    // Check for avatar initials
    expect(screen.getByText("RS")).toBeInTheDocument(); // Rob Scott
    expect(screen.getByText("AG")).toBeInTheDocument(); // Anthony Gianotti
  });

  it("should return null when no people are provided", () => {
    const { container } = render(
      <KeyPeople people={[]} companyName="Wesfarmers" />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("should return null when people is undefined", () => {
    const { container } = render(
      <KeyPeople people={undefined as unknown as Person[]} companyName="Wesfarmers" />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("should handle single person", () => {
    const singlePerson: Person[] = [mockPeople[0]!];
    
    render(<KeyPeople people={singlePerson} companyName="Test Company" />);

    expect(screen.getByText("Rob Scott")).toBeInTheDocument();
    expect(screen.queryByText("Anthony Gianotti")).not.toBeInTheDocument();
  });

  it("should correctly generate initials from names", () => {
    const peopleWithVariedNames: Person[] = [
      { name: "John", role: "CEO", bio: "Test bio" },
      { name: "Mary Jane Watson", role: "CFO", bio: "Test bio" },
      { name: "A B C D", role: "CTO", bio: "Test bio" },
    ];

    render(<KeyPeople people={peopleWithVariedNames} companyName="Test" />);

    expect(screen.getByText("J")).toBeInTheDocument(); // John -> J
    expect(screen.getByText("MJ")).toBeInTheDocument(); // Mary Jane -> MJ
    expect(screen.getByText("AB")).toBeInTheDocument(); // A B C D -> AB (max 2)
  });
});

