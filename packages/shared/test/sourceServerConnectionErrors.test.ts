import { describe, expect, it } from "vitest";
import {
  classifyRemotePairingFailure,
  classifyRemoteUnauthorizedFailure,
  isRemotePairingRequiredFailure,
  normalizeRemoteConnectionError,
} from "../src/source-server/connectionErrors.js";
import {
  isPublicZCodeErrorCode,
  publicZCodeErrorCodeSchema,
  REMOTE_AUTH_REQUIRED_ERROR_CODE,
  REMOTE_DEVICE_REVOKED_ERROR_CODE,
  REMOTE_PAIRING_CODE_INVALID_ERROR_CODE,
} from "../src/source-server/errorCodes.js";

const DIRECT_ERROR_CODES = [
  REMOTE_PAIRING_CODE_INVALID_ERROR_CODE,
  REMOTE_DEVICE_REVOKED_ERROR_CODE,
  REMOTE_AUTH_REQUIRED_ERROR_CODE,
] as const;

describe("局域网直连错误分类", () => {
  it("直连错误码进入公开码合同与运行时 schema", () => {
    for (const code of DIRECT_ERROR_CODES) {
      expect(isPublicZCodeErrorCode(code)).toBe(true);
      expect(publicZCodeErrorCodeSchema.parse(code)).toBe(code);
    }
    // wire 侧 body code 与公开错误码是两套词汇，不能互相放行。
    expect(isPublicZCodeErrorCode("device-revoked")).toBe(false);
    expect(isPublicZCodeErrorCode("pairing-code-invalid")).toBe(false);
  });

  it("normalize 保留直连错误码与 retryable，不落到 unknown", () => {
    for (const code of DIRECT_ERROR_CODES) {
      const failure = normalizeRemoteConnectionError(
        Object.assign(new Error("server rejected the request"), { code, retryable: false }),
      );
      expect(failure).toMatchObject({ code, retryable: false });
      expect(failure.message.trim()).not.toBe("");
    }
  });

  it.each([
    ["device-revoked", REMOTE_DEVICE_REVOKED_ERROR_CODE],
    ["auth-required", REMOTE_AUTH_REQUIRED_ERROR_CODE],
  ] as const)("401 body %s 分类为 %s", (bodyCode, expected) => {
    expect(classifyRemoteUnauthorizedFailure(bodyCode)).toMatchObject({
      code: expected,
      retryable: false,
    });
  });

  it("401 无稳定 body code 时返回 undefined，保持既有失败语义", () => {
    expect(classifyRemoteUnauthorizedFailure(undefined)).toBeUndefined();
    expect(classifyRemoteUnauthorizedFailure("something-else")).toBeUndefined();
    expect(classifyRemoteUnauthorizedFailure("")).toBeUndefined();
  });

  it.each([
    "pairing-code-invalid",
    "pairing-code-expired",
    "pairing-rate-limited",
    "pairing-disabled",
  ])("配对失败 %s 统一归入配对码分类且消息非空", (bodyCode) => {
    expect(classifyRemotePairingFailure(bodyCode, "detail from server")).toMatchObject({
      code: REMOTE_PAIRING_CODE_INVALID_ERROR_CODE,
      retryable: false,
      message: "detail from server",
    });
    const fallback = classifyRemotePairingFailure(bodyCode, undefined);
    expect(fallback.code).toBe(REMOTE_PAIRING_CODE_INVALID_ERROR_CODE);
    expect(fallback.message.trim()).not.toBe("");
  });

  it("只把 401 吊销/需配对两类识别为需重新配对", () => {
    expect(
      isRemotePairingRequiredFailure(
        Object.assign(new Error("x"), { code: REMOTE_DEVICE_REVOKED_ERROR_CODE }),
      ),
    ).toBe(true);
    expect(
      isRemotePairingRequiredFailure(
        Object.assign(new Error("x"), { code: REMOTE_AUTH_REQUIRED_ERROR_CODE }),
      ),
    ).toBe(true);
    expect(
      isRemotePairingRequiredFailure(
        Object.assign(new Error("x"), { code: REMOTE_PAIRING_CODE_INVALID_ERROR_CODE }),
      ),
    ).toBe(false);
    expect(isRemotePairingRequiredFailure(new Error("network down"))).toBe(false);
    expect(isRemotePairingRequiredFailure(undefined)).toBe(false);
  });
});
