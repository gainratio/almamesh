/**
 * ReportPdfDomains — Section XI: the seven life-domain forecast blocks. Each
 * almanac card carries the domain name + strength band, the key-graha line,
 * the current-emphasis line and the dated upcoming windows — all pre-formatted
 * on `ReportPdfDomains` (the engine's deterministic synthesis, not AI). Cards
 * never split across pages (`wrap={false}`).
 */

import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';
import {
  createDevanagariStyles,
  FONT_DISPLAY,
  FONT_MONO,
  palette,
  type as typeScale,
  useFontSheet,
} from '../theme';
import type { ReportPdfData, ReportPdfDomainBlock } from '../types';
import { ReportPdfHeading } from './ReportPdfHeading';

const local = StyleSheet.create({
  card: {
    marginBottom: 8,
    borderWidth: 0.5,
    borderColor: palette.rule,
    borderRadius: 4,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: palette.card,
  },
  head: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 3,
  },
  name: {
    fontFamily: FONT_DISPLAY,
    fontWeight: 600,
    fontSize: typeScale.lead,
    color: palette.inkSoft,
  },
  band: {
    fontFamily: FONT_MONO,
    fontSize: typeScale.micro,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: palette.brassDeep,
  },
  axes: {
    fontFamily: FONT_MONO,
    fontSize: typeScale.micro,
    color: palette.brassDeep,
    lineHeight: 1.5,
    marginBottom: 2,
  },
  stability: {
    fontFamily: FONT_MONO,
    fontSize: typeScale.micro,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: palette.faint,
    marginBottom: 2,
  },
  line: {
    fontSize: typeScale.caption,
    color: palette.ink,
    lineHeight: 1.5,
    marginBottom: 2,
  },
  evidence: {
    flexDirection: 'row',
    gap: 6,
    marginVertical: 4,
  },
  evidencePanel: {
    flexGrow: 1,
    flexBasis: 0,
    borderWidth: 0.5,
    borderColor: palette.rule,
    borderRadius: 3,
    paddingVertical: 5,
    paddingHorizontal: 7,
  },
  evidenceHeading: {
    fontFamily: FONT_MONO,
    fontSize: typeScale.micro,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: palette.brassDeep,
    marginBottom: 2,
  },
  evidenceBody: {
    fontSize: typeScale.micro,
    color: palette.muted,
    lineHeight: 1.4,
  },
  evidenceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 4,
    marginTop: 1,
  },
  evidenceValue: {
    fontFamily: FONT_MONO,
    color: palette.ink,
  },
  windowsLabel: {
    fontFamily: FONT_MONO,
    fontSize: typeScale.micro,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: palette.faint,
    marginTop: 4,
    marginBottom: 2,
  },
  window: {
    fontSize: typeScale.caption,
    color: palette.muted,
    lineHeight: 1.5,
  },
});

const localDevanagari = createDevanagariStyles(local);

function DomainCard({ block }: { block: ReportPdfDomainBlock }): ReactElement {
  const loc = useFontSheet(local, localDevanagari);
  return (
    <View style={loc.card} wrap={false}>
      <View style={loc.head}>
        <Text style={loc.name}>{block.name}</Text>
        <Text style={loc.band}>{block.band}</Text>
      </View>
      {/* Honesty furniture, mirrored from the screen's StabilityChip: whether
          this domain's verdict survives both candidate ascendants. Absent
          markers (older payloads) print nothing at all. */}
      {block.stability ? <Text style={loc.stability}>{block.stability}</Text> : null}
      <Text style={loc.axes}>{block.strengthAxes}</Text>
      <View style={loc.evidence}>
        <View style={loc.evidencePanel}>
          <Text style={loc.evidenceHeading}>{block.assay.heading}</Text>
          <Text style={loc.evidenceBody}>{block.assay.method}</Text>
          {block.assay.components.map((component) => (
            <View key={component.label} style={loc.evidenceRow}>
              <Text style={loc.evidenceBody}>{component.label}</Text>
              <Text style={[loc.evidenceBody, loc.evidenceValue]}>{component.value}</Text>
            </View>
          ))}
        </View>
        <View style={loc.evidencePanel}>
          <Text style={loc.evidenceHeading}>{block.avow.heading}</Text>
          <Text style={[loc.evidenceBody, loc.evidenceValue]}>{block.avow.status}</Text>
          <Text style={loc.evidenceBody}>{block.avow.scope}</Text>
        </View>
      </View>
      <Text style={loc.line}>{block.strengthLine}</Text>
      <Text style={loc.line}>{block.emphasisLine}</Text>
      <Text style={loc.windowsLabel}>{block.windowsLabel}</Text>
      {block.windows.length === 0 ? (
        <Text style={loc.window}>{block.windowsEmpty}</Text>
      ) : (
        block.windows.map((window, index) => (
          <Text key={index} style={loc.window}>
            {window}
          </Text>
        ))
      )}
    </View>
  );
}

interface ReportPdfDomainsProps {
  readonly data: ReportPdfData;
}

export function ReportPdfDomains({ data }: ReportPdfDomainsProps): ReactElement | null {
  const domains = data.domains;
  if (!domains) {
    return null;
  }
  return (
    <View>
      <ReportPdfHeading
        eyebrow={domains.chrome.eyebrow}
        title={domains.chrome.title}
        intro={domains.chrome.intro}
      />
      {domains.blocks.map((block) => (
        <DomainCard key={block.name} block={block} />
      ))}
    </View>
  );
}
