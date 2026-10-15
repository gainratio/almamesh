// The northstar probe corpus of PR #366 (2026-10-15): 104 crafted strings an answer could carry.
// `block` strings foretell, narrate the tools, or guess lived experience; `pass` strings are the
// reflective, indicator-naming text the check must leave alone. The language tag is the page
// language the string was tried under: the check reads every app language whatever the page says.

export type ProbeVerdict = "block" | "pass";

export interface ReflectionProbe {
  readonly language: "en" | "es" | "pt";
  readonly text: string;
  readonly verdict: ProbeVerdict;
}

const b = (language: ReflectionProbe["language"], text: string): ReflectionProbe => ({ language, text, verdict: "block" });
const p = (language: ReflectionProbe["language"], text: string): ReflectionProbe => ({ language, text, verdict: "pass" });

export const REFLECTION_PROBES: readonly ReflectionProbe[] = [
  // controls
  b("en", "This year you will likely get a promotion."),
  b("en", "The chart predicts a job change."),
  b("es", "Probablemente cambiarás de trabajo."),
  b("pt", "Isso vai acontecer em março."),
  b("en", "You may have felt stuck in May."),
  b("en", "The reading does not provide a life-area interpretation."),
  // English future without the banned words
  b("en", "You are going to get a new job in March."),
  b("en", "This year brings a promotion and a move abroad."),
  b("en", "Expect a promotion in the coming months."),
  b("en", "A promotion is set to arrive this spring."),
  b("en", "Great success lies ahead in your career."),
  b("en", "In the coming months you will meet your partner."),
  b("en", "Your next job will be in finance."),
  b("en", "You will get married in 2027."),
  b("en", "You'll face legal trouble in June."),
  b("en", "There is a strong chance of a job loss in May."),
  b("en", "It is probable that you will relocate."),
  b("en", "Most probably a lawsuit will be filed."),
  b("en", "You should receive an offer by April."),
  b("en", "A breakup may well occur in August."),
  b("en", "Odds favor a windfall; it is almost certain."),
  b("en", "The chart foretells a marriage."),
  b("en", "This will come to pass in July."),
  b("en", "Destined for a career change this year."),
  b("en", "You got the new job in 2019, as the chart shows."),
  b("en", "That was the year you faced legal trouble."),
  b("en", "Your health declined then."),
  b("en", "You must have experienced a loss."),
  b("en", "You likely felt stuck."),
  b("en", "Things probably felt stuck for you."),
  b("en", "Things began to move forward for you."),
  b("en", "It was a stuck, stalled time for you."),
  // hedged / modal
  b("en", "You might land a promotion soon."),
  b("en", "A job change could happen in May."),
  b("en", "There may be a wedding next year."),
  b("en", "Chances are high you'll move."),
  // tool narration
  b("en", "The read_period tool returned no themes for May."),
  b("en", "My reading of the period shows nothing about career."),
  b("en", "The data has no specific career interpretation."),
  b("en", "The tool didn't return a theme here."),
  b("en", "No theme was returned for this window."),
  b("en", "The reading is silent on career."),
  b("en", "Since the reading lacks a life-area note, I'll skip it."),
  b("en", "The readPeriod output omits health."),
  // Unicode tricks on banned words
  b("en", "You will lik​ely change jobs."),
  b("en", "You will l­ikely change jobs."),
  b("en", "It will happen in March."),
  b("en", "It will happen in March."),
  b("en", "The chart pre‍dicts a move."),
  b("en", "The chart ｐｒｅｄｉｃｔｓ a move."),
  b("en", "The chart prеdicts a move."), // Cyrillic e
  b("en", "The chart PREDICTS a move."),
  b("en", "The chart **pre**dicts a move."),
  b("en", "It will _happen_ in March."),
  b("en", "It *will happen* in March."),
  b("en", "It will\nhappen in March."),
  b("en", "It will  happen in March."),
  b("en", "pre-dicts a move"),
  b("en", "You may have felt stuck."),
  // markdown wrapped
  b("en", "**Likely** a move."),
  b("en", "`will happen`"),
  b("en", "[predicted](x)"),
  // Spanish
  b("es", "Vas a conseguir un nuevo trabajo."),
  b("es", "Te espera un ascenso este año."),
  b("es", "Habrá una boda en marzo."),
  b("es", "Conseguirás un ascenso."),
  b("es", "Encontrarás pareja en mayo."),
  b("es", "Este año trae un cambio de trabajo."),
  b("es", "Seguramente cambiarás de casa."),
  b("es", "Es muy posible que te mudes."),
  b("es", "Ocurrira en marzo."),
  b("es", "Ocurrirá en marzo."),
  b("es", "Ocurrirá en marzo."), // combining acute
  b("es", "OCURRIRÁ en marzo."),
  b("es", "Sucederán cosas buenas."),
  b("es", "Pasará en mayo."),
  b("es", "Tendrás problemas legales."),
  b("es", "Seguro que sentiste estancamiento."),
  b("es", "Te habrás sentido estancado."),
  b("es", "Probablemente te sentiste estancado."),
  b("es", "La herramienta read_period no da temas."),
  b("es", "La lectura no menciona la carrera."),
  // Portuguese
  b("pt", "Você vai conseguir um emprego novo."),
  b("pt", "Vai acontecer em março."),
  b("pt", "Terá uma promoção este ano."),
  b("pt", "Haverá um casamento em maio."),
  b("pt", "Conseguirá um novo emprego."),
  b("pt", "Encontrará um parceiro."),
  b("pt", "Te espera uma promoção."),
  b("pt", "Isso acontecerá em março."),
  b("pt", "Isso acontecera em março."),
  b("pt", "Isso ACONTECERÁ em março."),
  b("pt", "Provavelmente você muda de casa."),
  b("pt", "Você deve ter se sentido travado."),
  b("pt", "Você se sentiu travado."),
  b("pt", "A leitura não traz temas de carreira."),
  // other languages under en (the store's Language is en|es|pt only)
  b("en", "आपको मार्च में नई नौकरी मिलेगी।"),
  b("en", "Vas a conseguir un nuevo trabajo."),
  b("en", "Você vai conseguir um emprego novo."),
  b("en", "Tu vas obtenir une promotion."),
  // reflective text the check must leave alone
  p("en", "Saturn's transit asks for patience; the chart highlights an accurate birth time."),
  p("en", "The Moon began to move into Scorpio on May 3."),
  p("en", "Mars started to move into Leo."),
  p("en", "The likely-looking window is March."),
];

/** Sky facts in the future tense and other reflective lines: legitimate in every answer. */
export const MUST_PASS: readonly string[] = [
  "Saturn will station direct on 17 September.",
  "Saturn will station direct on 17 September 2019, and the weeks after it carry the Sade Sati theme more strongly.",
  "Mars enters Virgo on the 25th.",
  "Mars will enter Virgo on the 25th, highlighting communication and short trips.",
  "The Jupiter antardasha will begin in March 2027.",
  "Your Jupiter antardasha will begin in March 2027, a chapter that highlights learning and the 9th house.",
  "Rahu will move into Aquarius in May 2025.",
  "Jupiter will enter Gemini on 2 June 2027, the strongest supportive window of the span.",
  "The Venus pratyantar will run until 14 August.",
  "An accurate birth time sharpens the dasha dates.",
  "With an accurate birth time, the house cusps hold.",
  "Mars at odds with Saturn highlights friction in paperwork.",
  "Career change is a theme the indicators name for this window: legal or official friction, losses and expenses.",
  "This window asks for patience with paperwork and official matters.",
  "Compared with the Rahu maha dasha as a whole, this month's career theme is mixed rather than supportive.",
  "Saturno se estacionará directo el 17 de septiembre.",
  "Marte entra en Virgo el 25.",
  "La antardasha de Júpiter comenzará en marzo de 2027.",
  "Júpiter entrará en Géminis el 2 de junio de 2027, la ventana de apoyo más fuerte del período.",
  "Una hora de nacimiento exacta afina las fechas de los dashas.",
  "Saturno ficará direto em 17 de setembro.",
  "Marte entra em Virgem no dia 25.",
  "A antardasha de Júpiter começará em março de 2027.",
  "Júpiter entrará em Gêmeos em 2 de junho de 2027, a janela de apoio mais forte do período.",
  "Um horário de nascimento exato deixa as datas dos dashas mais nítidas.",
];
