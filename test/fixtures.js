// Shared test fixtures: a payload shaped exactly like the v4 /preview/ form sends.
const PNG_1x1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export function goodPayload(overrides = {}) {
  return {
    region: "houston",
    plant: "705 Manvel",
    visit_date: "2026-10-13",
    qa_observer_name: "Observer",
    plant_manager: "Manager",
    operators_present: "2",
    drums_reversed: "yes",
    drums_reversed_comment: "",
    daily_ops_comments: "Smooth day.",
    email: "someone@quikrete-readymix.com",
    timestamp: "2026-10-13T20:15:00.000Z",
    form_version: 2,
    test_mode: true,
    report: {
      sections: [
        {
          id: "operations",
          title: "Operations",
          photo_count: 1,
          questions: [
            { key: "drums_reversed", label: "Drums reversed?", answer: "yes", comment: "", pass: "yes" },
          ],
        },
      ],
      notes: [{ key: "daily_ops_comments", label: "Daily Operations Comments", value: "Smooth day." }],
    },
    images: [
      { name: "photo_1.png", data: PNG_1x1, section: "operations", section_title: "Operations", caption: "Drum" },
    ],
    cf_turnstile_token: "0.token-from-widget",
    ...overrides,
  };
}

export { PNG_1x1 };
