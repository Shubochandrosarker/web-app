import { notFound, redirect } from 'next/navigation';
import { apiFetch, ApiRequestError, can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { FormBuilder, type FormDefinition, type FormField } from '@/components/form-builder';

export const dynamic = 'force-dynamic';

interface FormDetail {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly fields: FormField[];
  readonly submitLabel: string;
  readonly successMessage: string | null;
  readonly outcomeConfig: { serviceId?: string };
  readonly notifyEmails: string[];
  readonly spamConfig: { honeypotField?: string; minFillMs?: number };
  readonly requiresConsent: boolean;
  readonly consentText: string | null;
  readonly enabled: boolean;
}

const EMPTY_FORM: FormDefinition = {
  slug: '',
  name: '',
  fields: [
    { name: 'name', label: 'Your name', type: 'text', required: true, options: [], accept: [] },
    { name: 'phone', label: 'Phone number', type: 'tel', required: true, options: [], accept: [] },
    {
      name: 'message',
      label: 'How can we help?',
      type: 'textarea',
      required: false,
      options: [],
      accept: [],
    },
  ],
  submitLabel: 'Send request',
  successMessage: '',
  outcomeConfig: {},
  notifyEmails: [],
  spamConfig: {},
  requiresConsent: true,
  consentText: '',
  enabled: true,
};

export default async function FormBuilderPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const { id } = await params;
  const isNew = id === 'new';

  let initial: FormDefinition = EMPTY_FORM;
  if (!isNew) {
    try {
      const detail = await apiFetch<FormDetail>(`/v1/cms/forms/${id}`);
      initial = {
        slug: detail.slug,
        name: detail.name,
        fields: detail.fields,
        submitLabel: detail.submitLabel,
        successMessage: detail.successMessage ?? '',
        outcomeConfig: detail.outcomeConfig ?? {},
        notifyEmails: detail.notifyEmails ?? [],
        spamConfig: detail.spamConfig ?? {},
        requiresConsent: detail.requiresConsent,
        consentText: detail.consentText ?? '',
        enabled: detail.enabled,
      };
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) notFound();
      throw error;
    }
  }

  const services = await apiFetch<{ items: { id: string; name: string }[] }>(
    '/v1/cms/services',
  ).catch(() => ({ items: [] }));

  return (
    <DashboardShell session={session} businessType="education_service" current="/forms">
      <div className="page-header">
        <div>
          <p className="breadcrumb">
            <a href="/forms">Forms</a>
          </p>
          <h1>{isNew ? 'New form' : initial.name}</h1>
        </div>
      </div>

      <FormBuilder
        formId={isNew ? null : id}
        initial={initial}
        services={services.items.map((service) => ({ id: service.id, label: service.name }))}
        canWrite={can(session, 'forms.write')}
      />
    </DashboardShell>
  );
}
