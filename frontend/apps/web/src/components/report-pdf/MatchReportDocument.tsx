/**
 * MatchReportDocument — locally-generated @react-pdf Kundli Matching &
 * Relationship report reusing the report-pdf Letterpress Observatory theme
 * and vector North-Indian Kundli plates.
 */

import type { ReactElement } from 'react';
import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import {
  DevanagariContext,
  palette,
  space,
  type as typeScale,
  useReportStyles,
} from './theme';
import type { MatchPdfData } from './buildMatchPdfData';
import { ReportPdfHeading } from './sections/ReportPdfHeading';
import { ReportPdfKundli } from './sections/ReportPdfKundli';
import { ReportPdfTable } from './sections/ReportPdfTable';

const PLATE_SIZE = 195;

const local = StyleSheet.create({
  heroBox: {
    backgroundColor: palette.paperDeep,
    borderWidth: 0.8,
    borderColor: palette.ruleStrong,
    borderRadius: 4,
    padding: space.md,
    marginBottom: space.lg,
  },
  scoreHeadline: {
    fontSize: typeScale.h2,
    color: palette.brassDeep,
    marginBottom: space.xs,
  },
  metaLine: {
    fontSize: typeScale.caption,
    color: palette.muted,
    marginTop: 3,
  },
  sectionSpacer: {
    marginTop: space.lg,
  },
  noteBox: {
    borderLeftWidth: 2,
    borderLeftColor: palette.brass,
    paddingLeft: space.md,
    marginTop: space.lg,
  },
  noteLabel: {
    fontSize: typeScale.micro,
    color: palette.brassDeep,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  noteBody: {
    fontSize: typeScale.caption,
    color: palette.muted,
    lineHeight: 1.5,
  },
  bulletLine: {
    fontSize: typeScale.small,
    color: palette.inkSoft,
    marginBottom: 4,
  },
});

function PageFooter({ note }: { note: string }): ReactElement {
  const s = useReportStyles();
  return (
    <>
      <View fixed style={s.pageFooterRule} />
      <Text fixed style={s.pageFooterNote}>
        {note}
      </Text>
      <Text
        fixed
        style={s.pageFooterCounter}
        render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`}
      />
    </>
  );
}

export interface MatchReportDocumentProps {
  readonly data: MatchPdfData;
}

export function MatchReportDocument({ data }: MatchReportDocumentProps): ReactElement {
  const s = useReportStyles(data.devanagari);
  const footerNote = `${data.labels.footerNote} · ${data.ayanamsaLabel} · ${data.generatedOn}`;

  return (
    <Document
      title={`AlmaMesh — ${data.title}`}
      author="AlmaMesh"
      subject="Vedic Kundli Matching & Relationship Report"
      creator="AlmaMesh"
      producer="AlmaMesh"
      creationDate={data.creationDate}
    >
      <DevanagariContext.Provider value={data.devanagari}>
        {/* Page 1: Header + Side-by-Side D1 Rasi Charts + Headline */}
        <Page size="A4" style={s.page}>
          <View style={s.coverTopRow}>
            <Text style={s.wordmark}>AlmaMesh</Text>
            <Text style={s.coverKicker}>{data.kicker}</Text>
          </View>
          <View style={{ marginTop: space.lg }}>
            <Text style={s.sectionTitle}>{data.title}</Text>
            <Text style={s.sectionIntro}>{data.subtitle}</Text>
          </View>

          <View style={local.heroBox}>
            {data.totalScoreLine ? (
              <Text style={local.scoreHeadline}>{data.totalScoreLine}</Text>
            ) : null}
            {data.grahaMaitriLine ? (
              <Text style={local.scoreHeadline}>{data.grahaMaitriLine}</Text>
            ) : null}
            {data.moonPairLine ? <Text style={local.metaLine}>{data.moonPairLine}</Text> : null}
            <Text style={local.metaLine}>
              {data.ayanamsaLabel} · {data.generatedOn}
            </Text>
          </View>

          {data.anchorGeometry || data.memberGeometry ? (
            <View>
              <ReportPdfHeading
                eyebrow={data.labels.chartsEyebrow}
                title={data.labels.chartsTitle}
              />
              <View style={s.chartsRow}>
                {data.anchorGeometry ? (
                  <View style={s.chartPlate}>
                    <Text style={s.chartCaption}>{data.anchorName} · D1</Text>
                    <View style={s.chartFrame}>
                      <ReportPdfKundli geometry={data.anchorGeometry} size={PLATE_SIZE} />
                    </View>
                  </View>
                ) : null}
                {data.memberGeometry ? (
                  <View style={s.chartPlate}>
                    <Text style={s.chartCaption}>{data.memberName} · D1</Text>
                    <View style={s.chartFrame}>
                      <ReportPdfKundli geometry={data.memberGeometry} size={PLATE_SIZE} />
                    </View>
                  </View>
                ) : null}
              </View>
            </View>
          ) : null}

          <PageFooter note={footerNote} />
        </Page>

        {/* Page 2: Ashtakoota 36-Gun Milan + Doshas + Mangal Dosha (for marriage edges) */}
        {data.kootaTable ? (
          <Page size="A4" style={s.page}>
            <ReportPdfHeading
              eyebrow={data.labels.compatEyebrow}
              title={data.labels.compatTitle}
            />
            <ReportPdfTable table={data.kootaTable} />

            {data.doshaLines.length > 0 ? (
              <View style={local.sectionSpacer}>
                <Text style={s.sectionEyebrow}>{data.labels.doshasTitle}</Text>
                {data.doshaLines.map((line) => (
                  <Text key={line} style={local.bulletLine}>
                    • {line}
                  </Text>
                ))}
              </View>
            ) : null}

            {data.mangalTable ? (
              <View style={local.sectionSpacer}>
                <Text style={s.sectionEyebrow}>{data.labels.mangalTitle}</Text>
                <ReportPdfTable table={data.mangalTable} />
                {data.mangalMutualNote ? (
                  <Text style={local.metaLine}>{data.mangalMutualNote}</Text>
                ) : null}
              </View>
            ) : null}

            <PageFooter note={footerNote} />
          </Page>
        ) : null}

        {/* Page 3: Chart Overlay + Dasha Synchrony + Verbatim Integrity Note */}
        <Page size="A4" style={s.page}>
          {data.overlayTable ? (
            <View>
              <ReportPdfHeading
                eyebrow={data.labels.overlayEyebrow}
                title={data.labels.overlayTitle}
              />
              <ReportPdfTable table={data.overlayTable} />
            </View>
          ) : null}

          {data.synchronyTable ? (
            <View style={local.sectionSpacer}>
              <ReportPdfHeading
                eyebrow={data.labels.synchronyEyebrow}
                title={data.labels.synchronyTitle}
              />
              <ReportPdfTable table={data.synchronyTable} dense />
            </View>
          ) : null}

          <View style={local.noteBox} wrap={false}>
            <Text style={local.noteLabel}>{data.labels.integrityLabel}</Text>
            <Text style={local.noteBody}>{data.integrityNote}</Text>
          </View>

          <PageFooter note={footerNote} />
        </Page>
      </DevanagariContext.Provider>
    </Document>
  );
}
