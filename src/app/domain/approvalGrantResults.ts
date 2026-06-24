export interface ApprovalGrantResultNotice {
  message: string;
  ok: boolean;
}

export async function resolveApprovalGrantResult(result: unknown): Promise<ApprovalGrantResultNotice> {
  const resolved = await result;
  if (typeof resolved === "object" && resolved != null) {
    const record = resolved as { ok?: unknown; message?: unknown };
    const message = typeof record.message === "string" && record.message.trim()
      ? record.message
      : record.ok === false ? "Approval grant failed" : "Approval grant created";
    return {
      message,
      ok: typeof record.ok === "boolean" ? record.ok : !message.toLowerCase().includes("failed"),
    };
  }

  const message = typeof resolved === "string" && resolved.trim()
    ? resolved
    : "Approval grant created";
  return {
    message,
    ok: !message.toLowerCase().includes("failed"),
  };
}
