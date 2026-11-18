import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import config from './mikro-orm.config.js';
import { WageringModule } from './modules/wagering/wagering.module.js';

@Module({
  imports: [
    MikroOrmModule.forRoot({
      ...config,
      autoLoadEntities: true, 
    }),
    WageringModule
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
