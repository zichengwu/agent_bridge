const SECRET_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bAIza[A-Za-z0-9_-]{8,}\b/g,
  /(Bearer\s+)[^\s,;]+/gi,
  /((?:api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|authorization|cookie|set-cookie)["'\s:=]+)[^\s,"'}]+/gi,
  /([?&](?:key|token|api_key)=)[^&\s]+/gi,
];

export function redactText(
  value: string,
  privatePaths: string[] = [],
  privateValues: string[] = [],
): string {
  let redacted = value;

  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (_match, prefix?: string) =>
      prefix === undefined ? "[REDACTED]" : `${prefix}[REDACTED]`,
    );
  }

  for (const path of privatePaths.filter(Boolean).sort((a, b) => b.length - a.length)) {
    redacted = redacted.replaceAll(path, "[ISOLATED_PATH]");
  }

  for (const secret of privateValues.filter(Boolean).sort((a, b) => b.length - a.length)) {
    redacted = redacted.replaceAll(secret, "[REDACTED]");
  }

  return redacted;
}

export function safeError(
  error: unknown,
  privatePaths: string[] = [],
  privateValues: string[] = [],
): string {
  if (error instanceof Error) {
    return redactText(`${error.name}: ${error.message}`, privatePaths, privateValues);
  }
  return redactText(String(error), privatePaths, privateValues);
}
