"use client";

import { Button } from "~/@/components/ui/button";

interface QuickActionsProps {
  onSelect: (question: string) => void;
  stockCode?: string;
}

const defaultQuestions = [
  "What are the most shorted stocks right now?",
  "Show me the latest weekly report summary",
  "Which sectors have the highest short interest?",
  "What's the market news today?",
];

export function QuickActions({ onSelect, stockCode }: QuickActionsProps) {
  const questions = stockCode
    ? [
        `What's the current short position on ${stockCode}?`,
        `Show me ${stockCode}'s peer comparison`,
        `Any recent director trades for ${stockCode}?`,
        `What's the latest news on ${stockCode}?`,
      ]
    : defaultQuestions;

  return (
    <div className="space-y-2 p-4">
      <p className="text-xs text-muted-foreground font-medium">
        Try asking:
      </p>
      <div className="flex flex-wrap gap-2">
        {questions.map((q) => (
          <Button
            key={q}
            variant="outline"
            size="sm"
            className="text-xs h-auto py-1.5 px-3 whitespace-normal text-left"
            onClick={() => onSelect(q)}
          >
            {q}
          </Button>
        ))}
      </div>
    </div>
  );
}
