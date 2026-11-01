import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

/*
 * Starting-point legal text that describes what the software actually does.
 * Have it reviewed by a lawyer for your jurisdiction (e.g. UAE PDPL, DHA/DOH
 * rules) before taking paying customers, and set VITE_LEGAL_ENTITY,
 * VITE_LEGAL_EMAIL and VITE_LEGAL_UPDATED for your deployment.
 */
const ENTITY = import.meta.env.VITE_LEGAL_ENTITY || 'FalconMed';
const EMAIL = import.meta.env.VITE_LEGAL_EMAIL || 'privacy@falconmed.app';
const UPDATED = import.meta.env.VITE_LEGAL_UPDATED || '1 November 2026';

function LegalPage({ title, sections }) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <Link to="/login" className="inline-flex items-center gap-1.5 text-sm text-mist-400 hover:text-mist-200">
        <ArrowLeft className="h-4 w-4" /> FalconMed Elite
      </Link>
      <h1 className="mt-6 font-display text-3xl font-semibold text-white">{title}</h1>
      <p className="mt-1 text-sm text-mist-500">Last updated {UPDATED}</p>
      <div className="mt-8 space-y-8">
        {sections.map(([heading, paragraphs]) => (
          <section key={heading}>
            <h2 className="font-display text-lg font-semibold text-white">{heading}</h2>
            {paragraphs.map((p) => (
              <p key={p.slice(0, 40)} className="mt-2 text-sm leading-relaxed text-mist-300">
                {p}
              </p>
            ))}
          </section>
        ))}
      </div>
      <p className="mt-12 text-sm text-mist-400">
        Questions: <a className="text-brand-300 hover:text-brand-200" href={`mailto:${EMAIL}`}>{EMAIL}</a>
      </p>
    </div>
  );
}

export function Terms() {
  return (
    <LegalPage
      title="Terms of Service"
      sections={[
        ['The service', [
          `FalconMed Elite is pharmacy queue analytics software provided by ${ENTITY}. These terms apply to the organisation that creates an account (“you”) and every person you invite.`,
        ]],
        ['Your account', [
          'You are responsible for the people you invite, the roles you give them and keeping passwords private. Tell us straight away if you think an account has been misused.',
          'You must not upload patient names, phone numbers, national or Emirates ID numbers, or other information that identifies a patient. The service is built to work without them and removes such columns from imported files.',
        ]],
        ['Trial, plans and payment', [
          'New organisations get a free trial. After it ends, the service is read-locked until you choose a paid plan; your data stays safe and you can still export it.',
          'Paid plans renew automatically each billing period until cancelled. Payments are processed by Stripe. You can change plan, update your card or cancel at any time from Billing; a cancellation takes effect at the end of the paid period.',
          'Plans limit the number of active branches and team members, as shown on the Billing page.',
        ]],
        ['Your data', [
          'Your organisation owns the data it puts into the service. We use it only to provide the service to you. You can export your tickets as CSV at any time and delete your organisation from Settings, which permanently removes its branches, people, tickets and imports.',
        ]],
        ['Acceptable use', [
          'Do not try to access another organisation’s data, probe or disrupt the service, or use it to break the law. We may suspend accounts that do.',
        ]],
        ['Availability and liability', [
          'We work to keep the service available and secure but provide it “as is”. FalconMed Elite supports operational decisions; it is not a clinical system and must not be relied on for clinical decisions. To the extent the law allows, our liability is limited to the fees you paid in the twelve months before a claim.',
        ]],
        ['Changes', [
          'We may update these terms and will tell organisation admins by email before material changes take effect.',
        ]],
      ]}
    />
  );
}

export function Privacy() {
  return (
    <LegalPage
      title="Privacy Policy"
      sections={[
        ['What we store', [
          'About people who use the service: name, work email, role, branch and counter, a salted password hash, sign-in times and the IP address of security-relevant actions (kept in your organisation’s security log).',
          'About pharmacy queues: ticket numbers, service type, arrival, call and finish times, the counter and pharmacist who served the ticket and, if you supply one, a de-identified patient reference code. We do not store patient names or contact details.',
        ]],
        ['Who processes it', [
          'Hosting and database providers run the service on our behalf. Stripe processes payments; we never see or store full card numbers. Our email provider delivers sign-in, invitation and billing emails. Each acts only on our instructions.',
        ]],
        ['Separation between organisations', [
          'Every organisation’s data is kept separate. People in one organisation cannot see another organisation’s branches, staff, tickets or imports.',
        ]],
        ['How long we keep it', [
          'For as long as your organisation has an account. When an admin deletes the organisation, its people, branches, tickets, imports and keys are deleted permanently. We keep a minimal record that the organisation existed and its billing history where the law requires it.',
        ]],
        ['Your rights', [
          `You can see and correct your profile under My account, and your admin can export or delete your organisation’s data. For any other request about your personal data, write to ${EMAIL}.`,
        ]],
        ['Security', [
          'Passwords are hashed with bcrypt, connections are encrypted, sign-in attempts are rate-limited and accounts lock after repeated failures. Security-relevant actions are recorded in each organisation’s security log.',
        ]],
      ]}
    />
  );
}
