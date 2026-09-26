import { Global, Module } from "@nestjs/common";
import { GracefulShutdown } from "./graceful-shutdown.js";
import { InFlightRequests } from "./in-flight-requests.js";

@Global()
@Module({
  providers: [InFlightRequests, GracefulShutdown],
  exports: [InFlightRequests],
})
export class LifecycleModule {}
