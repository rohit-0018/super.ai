import { z } from 'zod';

// ─── Enums ───────────────────────────────────────────────────────────────────

export enum AgentActionType {
  PlaceOrder = 'PlaceOrder',
  CancelOrder = 'CancelOrder',
  ModifyOrder = 'ModifyOrder',
  ClosePosition = 'ClosePosition',
  RequestHumanReview = 'RequestHumanReview',
  NoAction = 'NoAction',
}

export enum OrderSide {
  BUY = 'BUY',
  SELL = 'SELL',
}

export enum OrderType {
  MARKET = 'MARKET',
  LIMIT = 'LIMIT',
  STOP = 'STOP',
  STOP_LIMIT = 'STOP_LIMIT',
}

// ─── Zod enum schemas ────────────────────────────────────────────────────────

export const AgentActionTypeSchema = z.nativeEnum(AgentActionType);
export const OrderSideSchema = z.nativeEnum(OrderSide);
export const OrderTypeSchema = z.nativeEnum(OrderType);

// ─── Action Zod schemas ─────────────────────────────────────────────────────

export const PlaceOrderActionSchema = z.object({
  type: z.literal(AgentActionType.PlaceOrder).describe('Discriminant for place order action'),
  instrument: z.string().min(1).describe('Trading instrument symbol (e.g., BTC-USDT)'),
  side: OrderSideSchema.describe('Order side: BUY or SELL'),
  orderType: OrderTypeSchema.describe('Order type: MARKET, LIMIT, STOP, or STOP_LIMIT'),
  quantity: z.number().positive().describe('Order quantity (must be positive)'),
  price: z.number().positive().optional().describe('Limit price (required for LIMIT and STOP_LIMIT orders)'),
  stopPrice: z.number().positive().optional().describe('Stop trigger price (required for STOP and STOP_LIMIT orders)'),
  strategyId: z.string().min(1).describe('ID of the strategy originating this order'),
  clientOrderId: z.string().uuid().describe('Client-generated UUID for idempotency'),
}).refine(
  (data) => {
    if (data.orderType === OrderType.LIMIT || data.orderType === OrderType.STOP_LIMIT) {
      return data.price !== undefined;
    }
    return true;
  },
  { message: 'price is required for LIMIT and STOP_LIMIT orders' },
).refine(
  (data) => {
    if (data.orderType === OrderType.STOP || data.orderType === OrderType.STOP_LIMIT) {
      return data.stopPrice !== undefined;
    }
    return true;
  },
  { message: 'stopPrice is required for STOP and STOP_LIMIT orders' },
);

export const CancelOrderActionSchema = z.object({
  type: z.literal(AgentActionType.CancelOrder).describe('Discriminant for cancel order action'),
  clientOrderId: z.string().uuid().describe('Client order ID of the order to cancel'),
  instrument: z.string().min(1).describe('Trading instrument symbol'),
  strategyId: z.string().min(1).describe('ID of the strategy requesting cancellation'),
});

export const ModifyOrderActionSchema = z.object({
  type: z.literal(AgentActionType.ModifyOrder).describe('Discriminant for modify order action'),
  clientOrderId: z.string().uuid().describe('Client order ID of the order to modify'),
  instrument: z.string().min(1).describe('Trading instrument symbol'),
  newQuantity: z.number().positive().optional().describe('New order quantity'),
  newPrice: z.number().positive().optional().describe('New limit price'),
  strategyId: z.string().min(1).describe('ID of the strategy requesting modification'),
}).refine(
  (data) => data.newQuantity !== undefined || data.newPrice !== undefined,
  { message: 'At least one of newQuantity or newPrice must be provided' },
);

export const ClosePositionActionSchema = z.object({
  type: z.literal(AgentActionType.ClosePosition).describe('Discriminant for close position action'),
  instrument: z.string().min(1).describe('Trading instrument symbol of the position to close'),
  strategyId: z.string().min(1).describe('ID of the strategy requesting position closure'),
});

export const RequestHumanReviewActionSchema = z.object({
  type: z.literal(AgentActionType.RequestHumanReview).describe('Discriminant for human review request'),
  reason: z.string().min(1).describe('Explanation of why human review is needed'),
  context: z.record(z.string(), z.unknown()).describe('Arbitrary context data for the reviewer'),
  strategyId: z.string().min(1).describe('ID of the strategy requesting review'),
});

export const NoActionSchema = z.object({
  type: z.literal(AgentActionType.NoAction).describe('Discriminant for no-action decision'),
  reason: z.string().min(1).describe('Explanation of why no action was taken'),
});

// ─── Discriminated union schema ──────────────────────────────────────────────

// Note: We use a base discriminated union on the raw object shapes (without refinements)
// for parsing, then apply refinements separately. This is because z.discriminatedUnion
// requires ZodObject members.

const PlaceOrderActionBaseSchema = z.object({
  type: z.literal(AgentActionType.PlaceOrder),
  instrument: z.string().min(1),
  side: OrderSideSchema,
  orderType: OrderTypeSchema,
  quantity: z.number().positive(),
  price: z.number().positive().optional(),
  stopPrice: z.number().positive().optional(),
  strategyId: z.string().min(1),
  clientOrderId: z.string().uuid(),
});

const ModifyOrderActionBaseSchema = z.object({
  type: z.literal(AgentActionType.ModifyOrder),
  clientOrderId: z.string().uuid(),
  instrument: z.string().min(1),
  newQuantity: z.number().positive().optional(),
  newPrice: z.number().positive().optional(),
  strategyId: z.string().min(1),
});

export const AgentActionSchema = z.discriminatedUnion('type', [
  PlaceOrderActionBaseSchema,
  CancelOrderActionSchema,
  ModifyOrderActionBaseSchema,
  ClosePositionActionSchema,
  RequestHumanReviewActionSchema,
  NoActionSchema,
]);

// ─── Inferred types ──────────────────────────────────────────────────────────

export type PlaceOrderAction = z.infer<typeof PlaceOrderActionBaseSchema>;
export type CancelOrderAction = z.infer<typeof CancelOrderActionSchema>;
export type ModifyOrderAction = z.infer<typeof ModifyOrderActionBaseSchema>;
export type ClosePositionAction = z.infer<typeof ClosePositionActionSchema>;
export type RequestHumanReviewAction = z.infer<typeof RequestHumanReviewActionSchema>;
export type NoAction = z.infer<typeof NoActionSchema>;

export type AgentAction =
  | PlaceOrderAction
  | CancelOrderAction
  | ModifyOrderAction
  | ClosePositionAction
  | RequestHumanReviewAction
  | NoAction;
