import Link from "next/link";
import { sectionTitle } from "~/@/lib/typography";
import { FAQStructuredData } from "~/@/components/seo/enhanced-structured-data";
import { Disclosure } from "~/@/components/ui/disclosure";

/**
 * Compact homepage FAQ — server-rendered question-form headings plus matching
 * FAQPage JSON-LD. Copy is adapted from /faq; each answer links out to the
 * deeper explainer so the homepage stays short.
 *
 * `answer` is the canonical plain text emitted in the schema; `answerNode`
 * renders the SAME words with inline links so visible copy and structured data
 * never drift.
 */
const FAQS: Array<{
  question: string;
  answer: string;
  answerNode: React.ReactNode;
}> = [
  {
    question: "Is short selling legal in Australia?",
    answer:
      "Yes. Short selling is legal in Australia and regulated by ASIC, the Australian Securities and Investments Commission, which requires market participants to report their net short positions. Naked short selling — selling shares without first arranging to borrow them — is prohibited under section 1020B of the Corporations Act 2001.",
    answerNode: (
      <>
        Yes. Short selling is legal in Australia and regulated by ASIC, the
        Australian Securities and Investments Commission, which requires market
        participants to report their net short positions. Naked short selling —
        selling shares without first arranging to borrow them — is prohibited
        under section 1020B of the Corporations Act 2001.
      </>
    ),
  },
  {
    question: "What is short interest?",
    answer:
      "Short interest is the total number of shares held short in a stock, usually expressed as a percentage of the company's total shares on issue. On the ASX, below 5% is normal, 10-15% is elevated, and above 20% signals extreme bearish positioning and potential short squeeze pressure.",
    answerNode: (
      <>
        Short interest is the total number of shares held short in a stock,
        usually expressed as a percentage of the company&apos;s total shares on
        issue. On the ASX, below 5% is normal, 10-15% is elevated, and above 20%
        signals extreme bearish positioning and potential short squeeze
        pressure.
      </>
    ),
  },
  {
    question: "Why is ASIC short data 4 trading days delayed?",
    answer:
      "ASIC publishes aggregated short positions with a T+4 trading day delay, so each report reflects positions held four trading days earlier. The delay gives ASIC time to compile accurate figures, protects reporters from being front-run, and limits the scope for market manipulation.",
    answerNode: (
      <>
        ASIC publishes aggregated short positions with a T+4 trading day delay,
        so each report reflects positions held four trading days earlier. The
        delay gives ASIC time to compile accurate figures, protects reporters
        from being front-run, and limits the scope for market manipulation.
      </>
    ),
  },
  {
    question: "How do you short a stock on the ASX?",
    answer:
      "You borrow the shares through a broker with a securities lending arrangement in place, sell them at the current price, then buy them back later — profiting if the price has fallen. Covered short selling is the only legal form in Australia, and losses are theoretically unlimited if the price rises instead.",
    answerNode: (
      <>
        You borrow the shares through a broker with a securities lending
        arrangement in place, sell them at the current price, then buy them back
        later — profiting if the price has fallen. Covered short selling is the
        only legal form in Australia, and losses are theoretically unlimited if
        the price rises instead.{" "}
        <Link
          href="/learn/how-to-short-the-asx"
          className="underline underline-offset-4 hover:text-foreground"
        >
          Read the full guide to shorting the ASX
        </Link>
        .
      </>
    ),
  },
];

export function HomepageFaq() {
  return (
    <section className="container mx-auto px-4 py-6">
      <FAQStructuredData
        faqs={FAQS.map(({ question, answer }) => ({ question, answer }))}
      />
      <h2 className={sectionTitle}>
        Short selling on the ASX: common questions
      </h2>
      {/* Native <details> accordion: answers stay in the server-rendered HTML
          (so the visible copy still backs the FAQPage schema above) while the
          page reads as four questions rather than four paragraphs. */}
      <div className="mt-4 rounded-lg border border-border/60 px-4">
        {FAQS.map((faq, i) => (
          <Disclosure
            key={faq.question}
            defaultOpen={i === 0}
            title={
              <h3 className="text-sm font-semibold text-foreground">
                {faq.question}
              </h3>
            }
          >
            <p>{faq.answerNode}</p>
          </Disclosure>
        ))}
      </div>
      <p className="mt-4 text-sm text-muted-foreground">
        More answers in the{" "}
        <Link
          href="/faq"
          className="underline underline-offset-4 hover:text-foreground"
        >
          short selling FAQ
        </Link>
        , or work through the{" "}
        <Link
          href="/learn"
          className="underline underline-offset-4 hover:text-foreground"
        >
          short selling guides in Learn
        </Link>
        .
      </p>
    </section>
  );
}
