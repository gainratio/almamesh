/**
 * ReportPdfYogas — the LLM's woven yoga story (when a reading exists) over the
 * engine's yoga formations, each a self-contained card with its name, a
 * category·grade chip, the descriptive sentence, an optional birth-time
 * stability flag, and a mono planetary-signature footer. Cards `wrap={false}`
 * so a single yoga never splits across a page break (react-pdf paginates the
 * flow — no CSS `break-inside` bug).
 */

import type { ReactElement } from 'react';
import { Text, View } from '@react-pdf/renderer';
import { useReportStyles } from '../theme';
import type { ReportPdfData, ReportPdfYoga } from '../types';
import { ReportPdfHeading } from './ReportPdfHeading';

interface ReportPdfYogasProps {
  readonly data: ReportPdfData;
}

function YogaCard({ yoga }: { yoga: ReportPdfYoga }): ReactElement {
  const s = useReportStyles();
  return (
    <View style={s.yogaCard} wrap={false}>
      <View style={s.yogaHead}>
        <Text style={s.yogaName}>{yoga.name}</Text>
        <Text style={s.yogaChip}>{yoga.classification}</Text>
      </View>
      {/* Honesty furniture, mirrored from the screen's StabilityChip: does this
          verdict survive both candidate ascendants? Absent markers print nothing. */}
      {yoga.stability ? <Text style={s.yogaStability}>{yoga.stability}</Text> : null}
      {yoga.strength ? <Text style={s.yogaPct}>{yoga.strength}</Text> : null}
      {yoga.strengthLedger ? <Text style={s.yogaLedger}>{yoga.strengthLedger}</Text> : null}
      {yoga.activation ? <Text style={s.yogaLedger}>{yoga.activation}</Text> : null}
      <Text style={s.yogaDesc}>{yoga.description}</Text>
      {yoga.signature ? <Text style={s.yogaSignature}>{yoga.signature}</Text> : null}
    </View>
  );
}

export function ReportPdfYogas({ data }: ReportPdfYogasProps): ReactElement {
  const s = useReportStyles();
  const { yogas, yogaNarrative, labels } = data;
  return (
    <View>
      <ReportPdfHeading
        eyebrow={labels.yogasEyebrow}
        title={labels.yogasTitle}
        intro={labels.yogasIntro}
      />
      {/* The LLM's integrated yoga narrative — prose about the engine's OWN
          formed yogas, printed above the cards it describes. Absent on a
          natal-only report; the cards then stand alone, exactly as before. */}
      {(yogaNarrative ?? []).map((para, index) => (
        <Text key={`yoga-narrative-${index}`} style={s.narrativePara}>
          {para}
        </Text>
      ))}
      {yogas.map((yoga, index) => (
        <YogaCard key={`${index}-${yoga.name}-${yoga.signature}`} yoga={yoga} />
      ))}
    </View>
  );
}
