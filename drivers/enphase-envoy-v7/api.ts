const _importDynamic = new Function("modulePath", "return import(modulePath)");

async function fetch(...args: any) {
  const { default: fetch } = await _importDynamic("node-fetch");
  return fetch(...args);
}

import http from "node:http";
import https from "node:https";

import { ApiProduction, ApiMeters, ApiMeterReadings } from "./types";
import { URLSearchParams } from "node:url";

export default class EnphaseEnvoyApi {
  private address: string; // Null if only testing credentials
  private deviceSn: string;
  private username: string;
  private password: string;

  private accessToken: string | null = null;
  private sessionId: string | null = null;

  constructor(
    address: string,
    deviceSn: string,
    username: string,
    password: string
  ) {
    this.address = address;
    this.deviceSn = deviceSn;
    this.username = username;
    this.password = password;
  }

  setCredentials(username: string, password: string) {
    this.username = username;
    this.password = password;
  }

  private async fetchApiEndpoint(path: string, isRetry = false): Promise<any> {
    if (this.address === null) {
      throw new Error(
        "Attempted to fetch data for an uninitialised Enphase device"
      );
    }

    const url = `https://${this.address}/${path}`;

    const requestHeaders =
      this.sessionId !== null
        ? { Cookie: `sessionId=${this.sessionId}` }
        : undefined;

    const response = await fetch(url, {
      headers: requestHeaders,
      // Allow self-signed SSL (Envoy v7 uses self-signed certificate on HTTPS)
      // Keep backwards compatibility to warn users that v5 is not supported anymore
      agent: (parsedUrl: URL) => {
        if (parsedUrl.protocol == "http:") {
          return new http.Agent();
        } else {
          return new https.Agent({
            rejectUnauthorized: false,
          });
        }
      },
    });

    if (response.status >= 400 && response.status < 500 && !isRetry) {
      // Unauthorized, token might be expired - request token and retry (once)
      await this.getAccessToken();

      return this.fetchApiEndpoint(path, true);
    } else if (!response.ok) {
      throw new Error("An unknown error occurred while fetching inverter data:" + response.status + " and bearer: " + this.accessToken + " and sessionId: " + this.sessionId);
    }

    return response;
  }

  static async getEnphaseSessionId(
    username: string,
    password: string
  ): Promise<string> {
    const formData = new URLSearchParams();
    formData.append("user[email]", username);
    formData.append("user[password]", password);

    const authResponse = await fetch(
      "https://enlighten.enphaseenergy.com/login/login.json",
      { method: "POST", body: formData }
    );

    if (!authResponse.ok) {
      throw new Error(
        "Failed to authenticate to Enphase - are your username and password correct?"
      );
    }

    const parsedAuthResponse = await authResponse.json();

    return parsedAuthResponse.session_id;
  }

  async getAccessToken() {
    const sessionId = await EnphaseEnvoyApi.getEnphaseSessionId(
      this.username,
      this.password
    );

    const tokenResponse = await fetch(
      "https://entrez.enphaseenergy.com/tokens",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          serial_num: this.deviceSn,
          username: this.username,
        }),
      }
    );


    if (tokenResponse.ok) {
      this.accessToken = await tokenResponse.text();
    } else {
      throw new Error("An error occurred while retrieving an access token");
    }

    const checkJwtResponse = await fetch(
      `https://${this.address}/auth/check_jwt`,
      {
        method: "POST",
        headers: { "Authorization": `Bearer ${this.accessToken}` },
        agent: (parsedUrl: URL) => {
          if (parsedUrl.protocol == "http:") {
            return new http.Agent();
          } else {
            return new https.Agent({
              rejectUnauthorized: false,
            });
          }
        }
      }
    );

    if (checkJwtResponse.ok) {
      this.sessionId = await checkJwtResponse.headers.get("set-cookie")?.match(/sessionId=(.*?);/)?.[1];
    } else {
      throw new Error("An error occurred while retrieving an access token");
    }
  }

  async getProductionData(): Promise<any> {
    return (
      await this.fetchApiEndpoint("production.json")
    ).json() as Promise<any>;
  }

  async getMeters(): Promise<ApiMeters> {
    return (
      await this.fetchApiEndpoint("ivp/meters")
    ).json() as Promise<ApiMeters>;
  }

  async getMeterReadings(): Promise<ApiMeterReadings> {
    return (
      await this.fetchApiEndpoint("ivp/meters/readings")
    ).json() as Promise<ApiMeterReadings>;
  }
}
