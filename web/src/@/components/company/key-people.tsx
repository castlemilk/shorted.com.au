import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import type { Person } from "~/@/types/company-metadata";
import { Users } from "lucide-react";

interface KeyPeopleProps {
  people: Person[];
  companyName: string;
}

export function KeyPeople({ people, companyName }: KeyPeopleProps) {
  if (!people || people.length === 0) {
    return null;
  }

  const getInitials = (name: string) => {
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Users className="h-5 w-5" />
          Key People
        </CardTitle>
        <CardDescription>Leadership team at {companyName}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          {people.map((person, index) => (
            <div key={index} className="flex gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-border bg-primary/5 text-sm font-semibold text-primary">
                {getInitials(person.name)}
              </div>
              <div className="flex-1 space-y-1">
                <div>
                  <p className="font-semibold text-sm">{person.name}</p>
                  <p className="text-xs text-muted-foreground">{person.role}</p>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {person.bio}
                </p>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

