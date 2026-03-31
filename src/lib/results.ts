import type { AuditFinding, LineItem } from '$lib/types'

export interface ResultEntry {
  index: number
  item: LineItem
  finding: AuditFinding | null
}

export interface ResultGroup {
  key: string
  title?: string
  entries: ResultEntry[]
}

export interface ResultSection {
  key: string
  title: string
  groups: ResultGroup[]
}

const SECTION_ORDER = [
  'unbundling',
  'duplicate',
  'pharmacy_markup',
  'upcoding',
  'icd10_mismatch',
  'above_hospital_list_price',
  'other',
  'clean',
] as const

type SectionKey = (typeof SECTION_ORDER)[number]

const SECTION_TITLES: Record<SectionKey, string> = {
  unbundling: 'Unbundling Issues',
  duplicate: 'Duplicate Charges',
  pharmacy_markup: 'Pharmacy Markup',
  upcoding: 'Upcoding Flags',
  icd10_mismatch: 'Diagnosis Mismatches',
  above_hospital_list_price: 'Above Hospital List Price',
  other: 'Other Findings',
  clean: 'No Issues Flagged',
}

function sectionKeyForFinding(finding: AuditFinding | null): SectionKey {
  if (!finding) return 'clean'
  if (SECTION_ORDER.includes(finding.errorType as SectionKey)) {
    return finding.errorType as SectionKey
  }
  return 'other'
}

function entrySortCode(entry: ResultEntry): string {
  const pairCode = entry.finding?.ncciBundledWith ?? ''
  return `${pairCode}|${entry.item.cpt}|${String(entry.index).padStart(4, '0')}`
}

function findBundleAnchorIndex(entries: ResultEntry[], bundledWith: string): number | undefined {
  return entries.find((entry) => entry.item.cpt === bundledWith)?.index
}

function buildRelationMaps(entries: ResultEntry[]): {
  sectionByIndex: Map<number, SectionKey>
  groupByIndex: Map<number, string>
  titleByGroupKey: Map<string, string | undefined>
} {
  const sectionByIndex = new Map<number, SectionKey>()
  const groupByIndex = new Map<number, string>()
  const titleByGroupKey = new Map<string, string | undefined>()

  for (const entry of entries) {
    const finding = entry.finding
    if (!finding) continue

    if (finding.errorType === 'unbundling' && finding.ncciBundledWith) {
      const groupKey = `unbundling:bundled:${finding.ncciBundledWith}`
      titleByGroupKey.set(groupKey, `Should be bundled with ${finding.ncciBundledWith}`)
      sectionByIndex.set(entry.index, 'unbundling')
      groupByIndex.set(entry.index, groupKey)

      const relatedIndex = findBundleAnchorIndex(entries, finding.ncciBundledWith)
      if (relatedIndex !== undefined) {
        sectionByIndex.set(relatedIndex, 'unbundling')
        groupByIndex.set(relatedIndex, groupKey)
      }
      continue
    }

    if (finding.errorType === 'duplicate') {
      const groupKey = `duplicate:duplicate:${entry.item.cpt}`
      titleByGroupKey.set(groupKey, `Repeated ${entry.item.cpt}`)
      for (const relatedEntry of entries.filter((candidate) =>
        candidate.item.cpt === entry.item.cpt &&
        (candidate.finding === null || candidate.finding.errorType === 'duplicate')
      )) {
        sectionByIndex.set(relatedEntry.index, 'duplicate')
        groupByIndex.set(relatedEntry.index, groupKey)
      }
      continue
    }
  }

  return { sectionByIndex, groupByIndex, titleByGroupKey }
}

export function getDisplayDescription(item: LineItem, finding: AuditFinding | null): string {
  return finding?.standardDescription?.trim() || item.description?.trim() || 'No description available'
}

export function buildResultSections(lineItems: LineItem[], findings: AuditFinding[]): ResultSection[] {
  const findingsByIndex = new Map(findings.map((finding) => [finding.lineItemIndex, finding]))
  const entries: ResultEntry[] = lineItems.map((item, index) => ({
    index,
    item,
    finding: findingsByIndex.get(index) ?? null,
  }))
  const { sectionByIndex, groupByIndex, titleByGroupKey } = buildRelationMaps(entries)

  const sections = new Map<SectionKey, ResultSection>()
  for (const key of SECTION_ORDER) {
    sections.set(key, { key, title: SECTION_TITLES[key], groups: [] })
  }

  const groupedEntries = new Map<string, ResultEntry[]>()
  for (const entry of entries) {
    const sectionKey = sectionByIndex.get(entry.index) ?? sectionKeyForFinding(entry.finding)
    const groupKey = groupByIndex.get(entry.index) ?? `${sectionKey}:${sectionKeyForFinding(entry.finding)}:${entry.item.cpt}:${String(entry.index).padStart(4, '0')}`
    const bucket = groupedEntries.get(groupKey) ?? []
    bucket.push(entry)
    groupedEntries.set(groupKey, bucket)
  }

  const orderedGroupKeys = [...groupedEntries.keys()].sort((left, right) => {
    const [leftSection] = left.split(':') as [SectionKey]
    const [rightSection] = right.split(':') as [SectionKey]
    const sectionDelta = SECTION_ORDER.indexOf(leftSection) - SECTION_ORDER.indexOf(rightSection)
    if (sectionDelta !== 0) return sectionDelta

    const leftEntries = groupedEntries.get(left) ?? []
    const rightEntries = groupedEntries.get(right) ?? []
    return entrySortCode(leftEntries[0]) < entrySortCode(rightEntries[0]) ? -1 : 1
  })

  for (const groupKey of orderedGroupKeys) {
    const bucket = (groupedEntries.get(groupKey) ?? []).sort((left, right) =>
      entrySortCode(left).localeCompare(entrySortCode(right))
    )
    if (bucket.length === 0) continue

    const sectionKey = sectionByIndex.get(bucket[0].index) ?? sectionKeyForFinding(bucket[0].finding)
    sections.get(sectionKey)?.groups.push({
      key: groupKey,
      title: titleByGroupKey.get(groupKey),
      entries: bucket,
    })
  }

  return SECTION_ORDER
    .map((key) => sections.get(key)!)
    .filter((section) => section.groups.length > 0)
}
