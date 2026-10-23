"use client";

import {
  Suggestion,
  Suggestions,
} from "~/@/components/ai-elements/suggestion";

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
      <p className="text-xs font-medium text-muted-foreground">Try asking:</p>
      <Suggestions>
        {questions.map((question) => (
          <Suggestion
            key={question}
            suggestion={question}
            onClick={onSelect}
          />
        ))}
      </Suggestions>
    </div>
  );
}
