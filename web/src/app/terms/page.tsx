import { type Metadata } from "next";
import { Separator } from "~/@/components/ui/separator";

export const metadata: Metadata = {
  title: "Terms of Service | Shorted",
  description:
    "Terms of Service and Privacy Policy for Shorted - Australian short selling data and insights platform.",
};

const Page = () => {
  return (
    <div className="container mx-auto px-4 py-12 max-w-4xl">
      {/* Header Section */}
      <div className="space-y-4 mb-12">
        <h1 className="text-4xl font-bold tracking-tight">Terms of Service</h1>
        <p className="text-lg text-muted-foreground">
          Last updated: 12 October 2024
        </p>
        <Separator className="my-6" />
      </div>

      {/* Content Sections */}
      <div className="space-y-10 prose prose-slate dark:prose-invert max-w-none">
        {/* Section 1 */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold tracking-tight">
            1. Introduction
          </h2>
          <p className="text-base leading-7">
            Welcome to Shorted Pty Ltd ("Company", "we", "our", "us"). These
            Terms of Service ("Terms") govern your use of our website located at
            shorted.com.au ("Website") operated by the Company.
          </p>
        </section>

        {/* Section 2 */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold tracking-tight">
            2. Acceptance of Terms
          </h2>
          <p className="text-base leading-7">
            By accessing and using our Website, you accept and agree to be bound
            by these Terms. If you do not agree to these Terms, you must not use
            our Website.
          </p>
        </section>

        {/* Section 3 */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold tracking-tight">
            3. Proprietary Rights
          </h2>
          <p className="text-base leading-7">
            All content, features, and functionality on the Website, including
            but not limited to text, graphics, logos, icons, images, and
            software, are the exclusive property of the Company and are
            protected by Australian and international copyright, trademark,
            patent, trade secret, and other intellectual property or proprietary
            rights laws.
          </p>
        </section>

        {/* Section 4 */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold tracking-tight">
            4. Use License
          </h2>
          <p className="text-base leading-7">
            Permission is granted to temporarily download one copy of the
            materials (information or software) on the Website for personal,
            non-commercial transitory viewing only. This is the grant of a
            license, not a transfer of title, and under this license, you may
            not:
          </p>
          <ul className="list-disc list-inside space-y-2 ml-4 text-base leading-7">
            <li>Modify or copy the materials;</li>
            <li>Use the materials for any commercial purpose;</li>
            <li>
              Attempt to decompile or reverse engineer any software contained on
              the Website;
            </li>
            <li>
              Remove any copyright or other proprietary notations from the
              materials; or
            </li>
            <li>
              Transfer the materials to another person or "mirror" the materials
              on any other server.
            </li>
          </ul>
        </section>

        {/* Section 5 */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold tracking-tight">
            5. Disclaimer
          </h2>
          <p className="text-base leading-7">
            The materials on the Website are provided on an 'as is' basis. The
            Company makes no warranties, expressed or implied, and hereby
            disclaims and negates all other warranties including, without
            limitation, implied warranties or conditions of merchantability,
            fitness for a particular purpose, or non-infringement of
            intellectual property or other violation of rights.
          </p>
        </section>

        {/* Section 6 */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold tracking-tight">
            6. Limitations
          </h2>
          <p className="text-base leading-7">
            In no event shall the Company or its suppliers be liable for any
            damages (including, without limitation, damages for loss of data or
            profit, or due to business interruption) arising out of the use or
            inability to use the materials on the Website, even if the Company
            or an authorized representative has been notified orally or in
            writing of the possibility of such damage.
          </p>
        </section>

        {/* Section 7 */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold tracking-tight">
            7. Revisions and Errata
          </h2>
          <p className="text-base leading-7">
            The materials appearing on the Website could include technical,
            typographical, or photographic errors. The Company does not warrant
            that any of the materials on its Website are accurate, complete, or
            current. The Company may make changes to the materials contained on
            its Website at any time without notice.
          </p>
        </section>

        {/* Section 8 */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold tracking-tight">8. Links</h2>
          <p className="text-base leading-7">
            The Company has not reviewed all of the sites linked to its Website
            and is not responsible for the contents of any such linked site. The
            inclusion of any link does not imply endorsement by the Company. Use
            of any such linked website is at the user's own risk.
          </p>
        </section>

        {/* Section 9 */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold tracking-tight">
            9. Governing Law
          </h2>
          <p className="text-base leading-7">
            These Terms are governed by and construed in accordance with the
            laws of Australia, and you irrevocably submit to the exclusive
            jurisdiction of the courts in that State or location.
          </p>
        </section>

        {/* Section 10 */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold tracking-tight">
            10. Changes to Terms
          </h2>
          <p className="text-base leading-7">
            The Company may revise these Terms of Service for its Website at any
            time without notice. By using this Website, you are agreeing to be
            bound by the then-current version of these Terms of Service.
          </p>
        </section>

        {/* Section 11 */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold tracking-tight">
            11. Contact Information
          </h2>
          <p className="text-base leading-7">
            If you have any questions about these Terms, please contact us at{" "}
            <a
              href="mailto:contact@shorted.com.au"
              className="text-primary hover:underline"
            >
              contact@shorted.com.au
            </a>
          </p>
        </section>

        {/* Section 12 - Financial Disclaimer - Highlighted */}
        <section className="space-y-4 bg-muted/50 p-6 rounded-lg border border-border">
          <h2 className="text-2xl font-semibold tracking-tight">
            12. Financial Disclaimer
          </h2>
          <p className="text-base leading-7">
            The information provided on this Website is for general
            informational purposes only and does not constitute financial
            advice. While we endeavour to keep the information up to date and
            correct, we make no representations or warranties of any kind,
            express or implied, about the completeness, accuracy, reliability,
            suitability, or availability with respect to the Website or the
            information contained on the Website for any purpose. Any reliance
            you place on such information is therefore strictly at your own
            risk. You should consider seeking independent legal, financial,
            taxation, or other advice to check how the Website information
            relates to your unique circumstances.
          </p>
        </section>

        {/* Privacy Policy Section */}
        <Separator className="my-8" />

        <section className="space-y-4">
          <h2 className="text-3xl font-bold tracking-tight">Privacy Policy</h2>
          <p className="text-base leading-7">
            At Shorted Pty Ltd, we are committed to protecting your privacy.
            This Privacy Policy explains how we collect, use, and safeguard your
            information when you use our Website.
          </p>
        </section>

        <section className="space-y-4">
          <h3 className="text-xl font-semibold tracking-tight">
            Information We Collect
          </h3>
          <p className="text-base leading-7">
            We collect information that you provide directly to us, including
            when you create an account, use our services, or communicate with
            us. This may include your name, email address, and any other
            information you choose to provide.
          </p>
        </section>

        <section className="space-y-4">
          <h3 className="text-xl font-semibold tracking-tight">
            How We Use Your Information
          </h3>
          <p className="text-base leading-7">
            We use the information we collect to provide, maintain, and improve
            our services, to communicate with you, and to comply with legal
            obligations. We do not sell your personal information to third
            parties.
          </p>
        </section>

        <section className="space-y-4">
          <h3 className="text-xl font-semibold tracking-tight">
            Data Security
          </h3>
          <p className="text-base leading-7">
            We implement appropriate security measures to protect your personal
            information against unauthorized access, alteration, disclosure, or
            destruction. However, no method of transmission over the Internet is
            100% secure.
          </p>
        </section>

        <section className="space-y-4">
          <h3 className="text-xl font-semibold tracking-tight">Your Rights</h3>
          <p className="text-base leading-7">
            You have the right to access, update, or delete your personal
            information at any time. If you wish to exercise these rights,
            please contact us at{" "}
            <a
              href="mailto:privacy@shorted.com.au"
              className="text-primary hover:underline"
            >
              privacy@shorted.com.au
            </a>
          </p>
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
};

export default Page;
