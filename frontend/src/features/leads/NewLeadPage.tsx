import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type CreateLeadPayload } from '../../api/client';
import { ErrorBanner } from '../../components/common';

const EMPTY: CreateLeadPayload = {
  name: '',
  email: '',
  title: '',
  institutionName: '',
  department: '',
  country: '',
  profileUrl: '',
  researchSummary: '',
};

/**
 * Manual lead entry — one of the three ways a record enters the CRM
 * (the others being automated discovery and "feed a name to the discovery
 * engine", both arriving in Phase 2).
 */
export function NewLeadPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState<CreateLeadPayload>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicateNotice, setDuplicateNotice] = useState<string | null>(null);

  const set = (field: keyof CreateLeadPayload) => (value: string) =>
    setForm((prev) => ({ ...prev, [field]: value }));

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setDuplicateNotice(null);

    try {
      const { lead, wasDuplicate } = await api.createLead(form);

      if (wasDuplicate) {
        // Dedupe matched an existing record, so nothing was created. Say so
        // rather than silently navigating to a record the user did not just add.
        setDuplicateNotice(
          `This person is already in the CRM as "${lead.person.name}". Opening the existing record…`,
        );
        setTimeout(() => navigate(`/leads/${lead.id}`), 1600);
        return;
      }

      navigate(`/leads/${lead.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the lead');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Add a lead</h1>
          <p>Manual entry. Only a name is required — everything else can be filled in later.</p>
        </div>
        <Link className="btn" to="/leads">
          Cancel
        </Link>
      </div>

      {error && <ErrorBanner message={error} />}
      {duplicateNotice && <div className="alert alert-info">{duplicateNotice}</div>}

      <form className="card card-pad" onSubmit={handleSubmit} style={{ maxWidth: 760 }}>
        <div className="form-grid">
          <Field
            label="Full name *"
            value={form.name ?? ''}
            onChange={set('name')}
            placeholder="Dr. Lily Chen"
            required
          />
          <Field
            label="Email"
            type="email"
            value={form.email ?? ''}
            onChange={set('email')}
            placeholder="l.chen@mit.edu"
          />
          <Field
            label="Title / position"
            value={form.title ?? ''}
            onChange={set('title')}
            placeholder="Associate Professor"
          />
          <Field
            label="Institution"
            value={form.institutionName ?? ''}
            onChange={set('institutionName')}
            placeholder="Massachusetts Institute of Technology"
          />
          <Field
            label="Department"
            value={form.department ?? ''}
            onChange={set('department')}
            placeholder="Department of Chemistry"
          />
          <Field
            label="Country"
            value={form.country ?? ''}
            onChange={set('country')}
            placeholder="United States"
          />
        </div>

        <Field
          label="Profile URL"
          type="url"
          value={form.profileUrl ?? ''}
          onChange={set('profileUrl')}
          placeholder="https://chemistry.mit.edu/people/l-chen"
        />

        <div className="field">
          <label htmlFor="researchSummary">Research summary</label>
          <textarea
            id="researchSummary"
            value={form.researchSummary ?? ''}
            onChange={(e) => set('researchSummary')(e.target.value)}
            placeholder="What they work on. Left blank, the AI fills this in during Phase 2 enrichment."
          />
        </div>

        <button className="btn btn-primary" type="submit" disabled={saving || !form.name?.trim()}>
          {saving ? 'Saving…' : 'Save lead'}
        </button>
      </form>
    </>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  required,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  required?: boolean;
}) {
  const id = label.replace(/\W+/g, '-').toLowerCase();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        required={required}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
