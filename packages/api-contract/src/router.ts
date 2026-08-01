import { healthContract } from './health'

/**
 * Application contract. Real procedures are added per feature via OpenSpec
 * change proposals — this contract is the spec that `@checkin/api` must
 * implement and the type the client links against.
 */
export const contract = {
  health: healthContract,
}
