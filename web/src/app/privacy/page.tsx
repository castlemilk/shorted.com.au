import { type Metadata } from "next";
import Link from "next/link";
import { Separator } from "~/@/components/ui/separator";
import { siteConfig } from "~/@/config/site";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "Privacy Policy for Shorted.com.au - Learn how we collect, use, and protect your personal information when using our ASX short position tracking platform.",
  keywords: [
    "Shorted privacy policy",
    "data protection",
    "personal information",
    "ASX data privacy",
    "Australian privacy law",
  ],
  alternates: {
    canonical: `${siteConfig.url}/privacy`,
  },
  openGraph: {
    title: "Privacy Policy",
    description:
      "Learn how Shorted.com.au collects, uses, and protects your personal information.",
    url: `${siteConfig.url}/privacy`,
    type: "website",
  },
};

export default function PrivacyPage() {
  return (
    <div className="container mx-auto px-4 py-12 max-w-4xl">
      {/* Header Section */}
      <div className="space-y-4 mb-12">
        <h1 className="text-4xl font-bold tracking-tight">Privacy Policy</h1>
        <p className="text-lg text-muted-foreground">
          Last updated: February 2025
        </p>
        <Separator className="my-6" />
      </div>

      {/* Content Sections */}
      <div className="space-y-10 prose prose-slate dark:prose-invert max-w-none">
        {/* Introduction */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold tracking-tight">
            1. Introduction
          </h2>
          <p className="text-base leading-7">
            Shorted Pty Ltd (&quot;Company&quot;, &quot;we&quot;, &quot;our&quot;,
            &quot;us&quot;) is committed to protecting your privacy. This Privacy
            Policy explains how we collect, use, disclose, and safeguard your
            information when you visit our website at shorted.com.au
            (&quot;Website&quot;) and use our services.
          </p>
          <p className="text-base leading-7">
            We comply with the Australian Privacy Principles (APPs) contained in
            the Privacy Act 1988 (Cth). By using our Website, you consent to the
            data practices described in this policy.
          </p>
        </section>

        {/* Information We Collect */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold tracking-tight">
            2. Information We Collect
          </h2>

          <h3 className="text-xl font-medium tracking-tight">
            2.1 Information You Provide
          </h3>
          <p className="text-base leading-7">
            We collect information that you voluntarily provide when using our
            services, including:
          </p>
          <ul className="list-disc list-inside space-y-2 ml-4 text-base leading-7">
            <li>
              Account information (email address, name) when you create an
              account
            </li>
            <li>Watchlist and portfolio preferences you configure</li>
            <li>
              Communication data when you contact us or subscribe to updates
            </li>
            <li>Feedback and survey responses</li>
          </ul>

          <h3 className="text-xl font-medium tracking-tight">
            2.2 Automatically Collected Information
          </h3>
          <p className="text-base leading-7">
            When you access our Website, we automatically collect certain
            information, including:
          </p>
          <ul className="list-disc list-inside space-y-2 ml-4 text-base leading-7">
            <li>
              Device information (browser type, operating system, device type)
            </li>
            <li>Log data (IP address, access times, pages viewed)</li>
            <li>Usage patterns and interactions with our services</li>
            <li>
              Cookies and similar tracking technologies (see Section 5 below)
            </li>
          </ul>
        </section>

        {/* How We Use Your Information */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold tracking-tight">
            3. How We Use Your Information
          </h2>
          <p className="text-base leading-7">
            We use the information we collect for the following purposes:
          </p>
          <ul className="list-disc list-inside space-y-2 ml-4 text-base leading-7">
            <li>To provide, maintain, and improve our services</li>
            <li>To personalise your experience and remember your preferences</li>
            <li>
              To send you updates, alerts, and communications you have requested
            </li>
            <li>To respond to your enquiries and provide customer support</li>
            <li>To analyse usage patterns and improve our Website</li>
            <li>To detect, prevent, and address technical issues or fraud</li>
            <li>To comply with legal obligations</li>
          </ul>
        </section>

        {/* Sharing Your Information */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold tracking-tight">
            4. Sharing Your Information
          </h2>
          <p className="text-base leading-7">
            We do not sell, trade, or rent your personal information to third
            parties. We may share your information in the following
            circumstances:
          </p>
          <ul className="list-disc list-inside space-y-2 ml-4 text-base leading-7">
            <li>
              <strong>Service Providers:</strong> With third-party vendors who
              assist us in operating our Website (e.g., hosting, analytics,
              email services)
            </li>
            <li>
              <strong>Legal Requirements:</strong> When required by law, court
              order, or governmental authority
            </li>
            <li>
              <strong>Business Transfers:</strong> In connection with a merger,
              acquisition, or sale of assets
            </li>
            <li>
              <strong>With Your Consent:</strong> When you have given us
              explicit permission
            </li>
          </ul>
        </section>

        {/* Cookies */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold tracking-tight">
            5. Cookies and Tracking Technologies
          </h2>
          <p className="text-base leading-7">
            We use cookies and similar tracking technologies to enhance your
            experience on our Website. Cookies are small data files stored on
            your device.
          </p>

          <h3 className="text-xl font-medium tracking-tight">
            Types of Cookies We Use
          </h3>
          <ul className="list-disc list-inside space-y-2 ml-4 text-base leading-7">
            <li>
              <strong>Essential Cookies:</strong> Required for the Website to
              function properly (e.g., authentication, security)
            </li>
            <li>
              <strong>Preference Cookies:</strong> Remember your settings and
              preferences (e.g., theme, watchlist)
            </li>
            <li>
              <strong>Analytics Cookies:</strong> Help us understand how visitors
              interact with our Website
            </li>
          </ul>
          <p className="text-base leading-7">
            You can control cookies through your browser settings. Note that
            disabling certain cookies may affect Website functionality.
          </p>
        </section>

        {/* Data Security */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold tracking-tight">
            6. Data Security
          </h2>
          <p className="text-base leading-7">
            We implement appropriate technical and organisational measures to
            protect your personal information against unauthorised access,
            alteration, disclosure, or destruction. These measures include:
          </p>
          <ul className="list-disc list-inside space-y-2 ml-4 text-base leading-7">
            <li>Encryption of data in transit (HTTPS/TLS)</li>
            <li>Secure authentication mechanisms</li>
            <li>Regular security assessments and updates</li>
            <li>Access controls and employee training</li>
          </ul>
          <p className="text-base leading-7">
            However, no method of transmission over the Internet or electronic
            storage is 100% secure. While we strive to protect your information,
            we cannot guarantee absolute security.
          </p>
        </section>

        {/* Data Retention */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold tracking-tight">
            7. Data Retention
          </h2>
          <p className="text-base leading-7">
            We retain your personal information only for as long as necessary to
            fulfil the purposes outlined in this Privacy Policy, unless a longer
            retention period is required by law. When your information is no
            longer needed, we will securely delete or anonymise it.
          </p>
        </section>

        {/* Your Rights */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold tracking-tight">
            8. Your Rights
          </h2>
          <p className="text-base leading-7">
            Under the Australian Privacy Act, you have the following rights
            regarding your personal information:
          </p>
          <ul className="list-disc list-inside space-y-2 ml-4 text-base leading-7">
            <li>
              <strong>Access:</strong> Request a copy of the personal
              information we hold about you
            </li>
            <li>
              <strong>Correction:</strong> Request correction of inaccurate or
              incomplete information
            </li>
            <li>
              <strong>Deletion:</strong> Request deletion of your personal
              information (subject to legal requirements)
            </li>
            <li>
              <strong>Opt-out:</strong> Unsubscribe from marketing
              communications at any time
            </li>
          </ul>
          <p className="text-base leading-7">
            To exercise these rights, please contact us using the details in
            Section 11 below.
          </p>
        </section>

        {/* Third-Party Links */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold tracking-tight">
            9. Third-Party Links
          </h2>
          <p className="text-base leading-7">
            Our Website may contain links to third-party websites, including
            stock exchanges, financial news sites, and social media platforms.
            We are not responsible for the privacy practices of these external
            sites. We encourage you to review their privacy policies before
            providing any personal information.
          </p>
        </section>

        {/* Changes to This Policy */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold tracking-tight">
            10. Changes to This Privacy Policy
          </h2>
          <p className="text-base leading-7">
            We may update this Privacy Policy from time to time to reflect
            changes in our practices or legal requirements. We will notify you
            of any material changes by posting the updated policy on this page
            with a new &quot;Last updated&quot; date. Your continued use of the
            Website after such changes constitutes acceptance of the updated
            policy.
          </p>
        </section>

        {/* Contact Information */}
        <section className="space-y-4 bg-muted/50 p-6 rounded-lg border border-border">
          <h2 className="text-2xl font-semibold tracking-tight">
            11. Contact Us
          </h2>
          <p className="text-base leading-7">
            If you have any questions about this Privacy Policy or wish to
            exercise your privacy rights, please contact us at:
          </p>
          <ul className="list-none space-y-2 ml-4 text-base leading-7">
            <li>
              <strong>Email:</strong>{" "}
              <a
                href="mailto:support@shorted.com.au"
                className="text-primary hover:underline"
              >
                support@shorted.com.au
              </a>
            </li>
            <li>
              <strong>General enquiries:</strong>{" "}
              <a
                href="mailto:support@shorted.com.au"
                className="text-primary hover:underline"
              >
                support@shorted.com.au
              </a>
            </li>
          </ul>
          <p className="text-base leading-7 mt-4">
            If you are not satisfied with our response to a privacy concern, you
            may lodge a complaint with the{" "}
            <a
              href="https://www.oaic.gov.au/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Office of the Australian Information Commissioner (OAIC)
            </a>
            .
          </p>
        </section>

        {/* Related Links */}
        <section className="space-y-4 mt-8">
          <h2 className="text-xl font-semibold tracking-tight">Related Pages</h2>
          <ul className="list-disc list-inside space-y-2 ml-4 text-base leading-7">
            <li>
              <Link href="/terms" className="text-primary hover:underline">
                Terms of Service
              </Link>
            </li>
            <li>
              <Link href="/about" className="text-primary hover:underline">
                About Shorted
              </Link>
            </li>
            <li>
              <Link href="/faq" className="text-primary hover:underline">
                Frequently Asked Questions
              </Link>
            </li>
          </ul>
        </section>
      </div>

      {/* Footer */}
      <div className="mt-16 pt-8 border-t border-border">
        <p className="text-sm text-muted-foreground text-center">
          © {new Date().getFullYear()} Shorted Pty Ltd. All rights reserved.
        </p>
      </div>
    </div>
  );
}
