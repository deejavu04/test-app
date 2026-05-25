#!/bin/bash

while true; do
  curl $(minikube service frontend --url)
  sleep 1
done