/** Characters allowed in an emoji name. Slack allows non-ASCII names such as :承知:. */
export const EMOJI_NAME = String.raw`[^\s:<>\`*~]+`;

/** `:name:` optionally followed by `:skin-tone-N:`; group 1 is the name, group 2 the tone. */
export const EMOJI_CODE = String.raw`:(${EMOJI_NAME}):(?::skin-tone-([2-6]):)?`;
