"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "~/@/components/ui/accordion";
import { Badge } from "~/@/components/ui/badge";
import type { EnrichedCompanyMetadata } from "~/@/types/company-metadata";
import { KeyPeopleList } from "./key-people";
import {
  Building2,
  BookOpen,
  History,
  TrendingUp,
  AlertTriangle,
  Newspaper,
  Users,
} from "lucide-react";

interface CompanyInsightsCardProps {
  data: EnrichedCompanyMetadata;
}

interface SectionDef {
  value: string;
  label: string;
  icon: React.ReactNode;
  count?: number;
  content: React.ReactNode;
}

/**
 * Consolidated company research card: one card, one fact per section,
 * progressive disclosure via accordion instead of six stacked cards.
 * Renders on the Overview tab only — the Financials tab shows reports
 * via FinancialReportsSection instead of repeating this content.
 */
export function CompanyInsightsCard({ data }: CompanyInsightsCardProps) {
  const validPeople = data.key_people?.filter((p) => p.name?.trim()) ?? [];

  const sections: SectionDef[] = [];

  if (data.enhanced_summary) {
    sections.push({
      value: "overview",
      label: "Overview",
      icon: <BookOpen className="h-4 w-4 text-muted-foreground" />,
      content: (
        <p className="text-sm text-muted-foreground leading-relaxed">
          {data.enhanced_summary}
        </p>
      ),
    });
  }

  if (data.company_history) {
    sections.push({
      value: "history",
      label: "History",
      icon: <History className="h-4 w-4 text-muted-foreground" />,
      content: (
        <p className="text-sm text-muted-foreground leading-relaxed">
          {data.company_history}
        </p>
      ),
    });
  }

  if (data.competitive_advantages) {
    sections.push({
      value: "advantages",
      label: "Competitive advantages",
      icon: (
        <TrendingUp className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
      ),
      content: (
        <p className="text-sm text-muted-foreground leading-relaxed">
          {data.competitive_advantages}
        </p>
      ),
    });
  }

  if (data.risk_factors && data.risk_factors.length > 0) {
    sections.push({
      value: "risks",
      label: "Risk factors",
      icon: (
        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
      ),
      count: data.risk_factors.length,
      content: (
        <ul className="space-y-2">
          {data.risk_factors.map((risk, index) => (
            <li
              key={index}
              className="text-sm text-muted-foreground flex items-start"
            >
              <span className="mr-2 text-amber-600 dark:text-amber-400">•</span>
              <span>{risk}</span>
            </li>
          ))}
        </ul>
      ),
    });
  }

  if (data.recent_developments) {
    sections.push({
      value: "developments",
      label: "Recent developments",
      icon: <Newspaper className="h-4 w-4 text-blue-600 dark:text-blue-400" />,
      content: (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Last 6 months</p>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {data.recent_developments}
          </p>
        </div>
      ),
    });
  }

  if (validPeople.length > 0) {
    sections.push({
      value: "people",
      label: "Key people",
      icon: <Users className="h-4 w-4 text-muted-foreground" />,
      count: validPeople.length,
      content: <KeyPeopleList people={validPeople} />,
    });
  }

  const hasTags = Boolean(data.tags && data.tags.length > 0);

  if (!hasTags && sections.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Building2 className="h-5 w-5" />
          Company
        </CardTitle>
        <CardDescription>
          AI-generated research profile
          {data.company_name ? ` of ${data.company_name}` : ""}
        </CardDescription>
        {hasTags && (
          <div className="flex flex-wrap gap-1.5 pt-2">
            {data.tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="text-xs">
                {tag}
              </Badge>
            ))}
          </div>
        )}
      </CardHeader>
      {sections.length > 0 && (
        <CardContent className="pt-0">
          <Accordion type="multiple">
            {sections.map((section, index) => (
              <AccordionItem
                key={section.value}
                value={section.value}
                className={index === sections.length - 1 ? "border-b-0" : ""}
              >
                <AccordionTrigger className="py-3 text-sm hover:no-underline [&>svg]:text-muted-foreground">
                  <span className="flex items-center gap-2 text-left">
                    {section.icon}
                    {section.label}
                    {section.count !== undefined && (
                      <span className="text-xs text-muted-foreground tabular-nums font-normal">
                        {section.count}
                      </span>
                    )}
                  </span>
                </AccordionTrigger>
                <AccordionContent>{section.content}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </CardContent>
      )}
    </Card>
  );
}
