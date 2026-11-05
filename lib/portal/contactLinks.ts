// lib/portal/contactLinks.ts — keep company-owned records visible in the LRL client hub.
//
// The hub (GHL Client App Builder app) shows Client Stage and Milestone records on company-scoped
// pages, but the portal decides visibility through CONTACT links, even for company scope. A record
// linked only to its company is invisible to that company's people. So every such record must also
// be linked to each contact on its company.
//
// Two entry points:
//   - linkRecordToCompanyContacts: right after a writer creates a record (createStageRecord).
//   - sweepPortalContactLinks: the nightly backstop. Milestones are created by staff in GHL, not by
//     this app, and contacts join companies after their records exist; the sweep fixes both.
// Both only ADD missing links. They never remove one (a contact who left a company keeps its past
// records; unlinking is a staff decision).

import { GhlClient, ghl } from '../ghl/client';
import { BUSINESSES_CONTACTS_ASSOCIATION, createRelation, getAllRelations, resolveAssociationDef } from '../ghl/associations';

export interface PortalLinkSpec {
  objectKey: string;
  /** Association key linking the record to its company. */
  companyAssocKey: string;
  /** Association key linking the record to a contact (created by the Client App Builder). */
  contactAssocKey: string;
}

export const PORTAL_LINK_SPECS: PortalLinkSpec[] = [
  { objectKey: 'custom_objects.business_stage', companyAssocKey: 'company_business_stage', contactAssocKey: 'business_stage_contact' },
  { objectKey: 'custom_objects.milestones', companyAssocKey: 'company_milestone', contactAssocKey: 'milestones_contact' },
];

export const specFor = (objectKey: string) => PORTAL_LINK_SPECS.find((s) => s.objectKey === objectKey);

interface Rel {
  associationKey?: string;
  firstObjectKey?: string;
  firstRecordId?: string;
  secondObjectKey?: string;
  secondRecordId?: string;
}

/** The id on the `objectKey` side of each relation with this association key (deduped). */
export function otherSide(rels: Rel[], associationKey: string, objectKey: string): string[] {
  const ids = rels
    .filter((r) => r.associationKey === associationKey)
    .map((r) => (r.firstObjectKey === objectKey ? r.firstRecordId : r.secondObjectKey === objectKey ? r.secondRecordId : undefined));
  return Array.from(new Set(ids.filter(Boolean) as string[]));
}

/** Contacts on the company that the record is not yet linked to. Pure. */
export function missingContactIds(recordRels: Rel[], spec: PortalLinkSpec, companyContactIds: string[]): string[] {
  const have = new Set(otherSide(recordRels, spec.contactAssocKey, 'contact'));
  return Array.from(new Set(companyContactIds)).filter((id) => !have.has(id));
}

/** Contacts whose primary company is `companyId`. */
export async function companyContactIds(companyId: string, client: GhlClient = ghl()): Promise<string[]> {
  return otherSide(await getAllRelations(companyId, client), BUSINESSES_CONTACTS_ASSOCIATION, 'contact');
}

/** POST one record↔contact link, putting each id on the side the association definition says. */
async function linkContact(spec: PortalLinkSpec, recordId: string, contactId: string, client: GhlClient): Promise<void> {
  const def = await resolveAssociationDef(spec.contactAssocKey, client);
  if (!def) throw new Error(`association ${spec.contactAssocKey} not found`);
  const contactFirst = def.first.objectKey === 'contact';
  await createRelation(
    {
      associationId: def.id,
      firstRecordId: contactFirst ? contactId : recordId,
      secondRecordId: contactFirst ? recordId : contactId,
    },
    client,
  );
}

export interface LinkResult {
  linked: string[];
  failed: { contactId: string; error: string }[];
}

/**
 * Link a record to every contact on `companyId` it is not linked to yet. `recordRels` skips the
 * read when the caller knows the record has no contact links (a record it just created).
 */
export async function linkRecordToCompanyContacts(
  objectKey: string,
  recordId: string,
  companyId: string,
  opts: { client?: GhlClient; contactIds?: string[]; recordRels?: Rel[]; apply?: boolean } = {},
): Promise<LinkResult> {
  const client = opts.client ?? ghl();
  const spec = specFor(objectKey);
  if (!spec) throw new Error(`no portal link spec for ${objectKey}`);
  const contacts = opts.contactIds ?? (await companyContactIds(companyId, client));
  const rels = opts.recordRels ?? (await getAllRelations(recordId, client));
  const todo = missingContactIds(rels, spec, contacts);
  const out: LinkResult = { linked: [], failed: [] };
  if (opts.apply === false) return { linked: todo, failed: [] };
  for (const contactId of todo) {
    try {
      await linkContact(spec, recordId, contactId, client);
      out.linked.push(contactId);
    } catch (e: any) {
      out.failed.push({ contactId, error: String(e?.message ?? e).slice(0, 300) });
    }
  }
  return out;
}

export interface SweepRow {
  objectKey: string;
  recordId: string;
  companyId: string | null;
  contactIds: string[];
  error?: string;
}

/** Every record of an object (records search, paged). */
async function allRecordIds(objectKey: string, client: GhlClient): Promise<string[]> {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const d = await client.request<any>({
      method: 'POST',
      path: `/objects/${objectKey}/records/search`,
      autoLocation: false,
      body: { locationId: client.locationId, page, pageLimit: 100 },
    });
    const recs: any[] = d.records ?? d.data ?? [];
    ids.push(...recs.map((r) => r.id).filter(Boolean));
    if (recs.length < 100) break;
  }
  return ids;
}

/**
 * Nightly backstop: for every stage and milestone record, add any missing links to its company's
 * contacts. Dry-run unless `apply`. Returns one row per record that needed (or got) links, plus
 * records with no company, so the report shows what is still hidden.
 */
export async function sweepPortalContactLinks(
  opts: { client?: GhlClient; apply?: boolean; log?: (s: string) => void } = {},
): Promise<{ records: number; rows: SweepRow[]; noContacts: string[] }> {
  const client = opts.client ?? ghl();
  const log = opts.log ?? (() => {});
  const contactsByCompany = new Map<string, string[]>();
  const rows: SweepRow[] = [];
  const noContacts = new Set<string>();
  let records = 0;
  for (const spec of PORTAL_LINK_SPECS) {
    const ids = await allRecordIds(spec.objectKey, client);
    log(`${spec.objectKey}: ${ids.length} records`);
    for (const recordId of ids) {
      records++;
      try {
        const rels = await getAllRelations(recordId, client);
        const companies = otherSide(rels, spec.companyAssocKey, 'business');
        if (!companies.length) {
          rows.push({ objectKey: spec.objectKey, recordId, companyId: null, contactIds: [] });
          continue;
        }
        for (const companyId of companies) {
          if (!contactsByCompany.has(companyId)) contactsByCompany.set(companyId, await companyContactIds(companyId, client));
          const contactIds = contactsByCompany.get(companyId)!;
          if (!contactIds.length) noContacts.add(companyId);
          const res = await linkRecordToCompanyContacts(spec.objectKey, recordId, companyId, {
            client, contactIds, recordRels: rels, apply: opts.apply,
          });
          if (res.linked.length || res.failed.length)
            rows.push({
              objectKey: spec.objectKey, recordId, companyId, contactIds: res.linked,
              error: res.failed.length ? res.failed.map((f) => `${f.contactId}: ${f.error}`).join('; ') : undefined,
            });
        }
      } catch (e: any) {
        rows.push({ objectKey: spec.objectKey, recordId, companyId: null, contactIds: [], error: String(e?.message ?? e).slice(0, 300) });
      }
    }
  }
  return { records, rows, noContacts: Array.from(noContacts) };
}
