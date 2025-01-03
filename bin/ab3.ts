#!/usr/bin/env node
import 'dotenv/config';
import * as cdk from 'aws-cdk-lib';
import { Ab3Stack } from '../lib/ab3-stack';

const app = new cdk.App();
new Ab3Stack(app, 'Ab3Stack', {
  env: { account: process.env.ACCOUNT, region: process.env.REGION }
/* For more information, see https://docs.aws.amazon.com/cdk/latest/guide/environments.html */
});
