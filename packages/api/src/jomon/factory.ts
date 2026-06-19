import type { JomonConfig } from './config'
import type { JomonClient } from './types'
import { StubJomonClient } from './stub'
import { JomonV1Client, JomonV2Client } from './http'

/**
 * Build the configured Jomon client. `JOMON_API_VERSION` selects the driver
 * (`stub` | `v1` | `v2`, default `stub`); the domain is unaffected by the
 * choice. Constructing the `stub` driver is key-free, so the Nitro host can
 * attach one to every request Context; live drivers validate their env at
 * construction. (design D1 / D5)
 */
export function createJomonClient(config: JomonConfig): JomonClient {
  switch (config.version) {
    case 'v1':
      return new JomonV1Client(config.baseUrl, config.token)
    case 'v2':
      return new JomonV2Client(config.baseUrl, config.token)
    default:
      return new StubJomonClient(config.stubApproved ?? [])
  }
}
