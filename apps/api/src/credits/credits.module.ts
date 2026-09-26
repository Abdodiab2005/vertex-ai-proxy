import { Module } from "@nestjs/common";
import { RedisModule } from "../redis/redis.module.js";
import { CreditLedgerService } from "./credit-ledger.service.js";
import { CreditReservationStore } from "./credit-reservation.store.js";
import { UsageAccountingService } from "./usage-accounting.service.js";

@Module({
  imports: [RedisModule],
  providers: [CreditLedgerService, CreditReservationStore, UsageAccountingService],
  exports: [CreditLedgerService, CreditReservationStore, UsageAccountingService],
})
export class CreditsModule {}
