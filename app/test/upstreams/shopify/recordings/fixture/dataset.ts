// Recorded from the read fixture store by the step engine (record.live.ts); scrubbed. Never edit by hand: fix the
// fake instead, or re-record.
export const dataset: unknown = {
 "v": 1,
 "apiVersion": "2026-10",
 "recordedOn": "2026-11-20",
 "documentHashes": {
  "OrdersSearch": "bb1a2fa3",
  "OrderGet": "52bc7aee",
  "RefundsSearch": "97532501",
  "ReturnsSearch": "b638d796",
  "ProductsSearch": "3c181229",
  "InventoryLevelsGet": "11073517",
  "RecordScopes": "ac0479a2",
  "RecordOrders": "149abf6b",
  "RecordRefunds": "b13e0dfa",
  "RecordReturns": "8d270766",
  "RecordProducts": "b73d1953"
 },
 "currency": "USD",
 "orders": [
  {
   "id": "gid://shopify/Order/1",
   "name": "#1001",
   "processedAt": "2026-11-14T16:14:48Z",
   "updatedAt": "2026-11-19T16:43:37Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "UNFULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "136.81",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0007",
      "title": "Lite Trekking Poles",
      "currentQuantity": 1,
      "unfulfilledQuantity": 1,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "136.81",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/2",
   "name": "#1003",
   "processedAt": "2026-11-14T16:08:09Z",
   "updatedAt": "2026-11-19T17:34:50Z",
   "cancelledAt": null,
   "displayFinancialStatus": "REFUNDED",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "168.46",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 0,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0062",
      "title": "Summit Camp Stove",
      "currentQuantity": 0,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "168.46",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [
    {
     "createdAt": "2026-11-19T17:34:50Z",
     "note": "Igniter failed",
     "totalRefundedSet": {
      "shopMoney": {
       "amount": "168.46",
       "currencyCode": "USD"
      }
     },
     "refundLineItems": {
      "nodes": [
       {
        "quantity": 1,
        "restockType": "NO_RESTOCK",
        "lineItem": {
         "sku": "P4-0062"
        }
       }
      ]
     }
    }
   ],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/3",
   "name": "#1004",
   "processedAt": "2026-11-17T06:21:04Z",
   "updatedAt": "2026-11-19T17:34:51Z",
   "cancelledAt": null,
   "displayFinancialStatus": "REFUNDED",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "168.46",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 0,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0062",
      "title": "Summit Camp Stove",
      "currentQuantity": 0,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "168.46",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [
    {
     "createdAt": "2026-11-19T17:34:51Z",
     "note": "Igniter failed",
     "totalRefundedSet": {
      "shopMoney": {
       "amount": "168.46",
       "currencyCode": "USD"
      }
     },
     "refundLineItems": {
      "nodes": [
       {
        "quantity": 1,
        "restockType": "NO_RESTOCK",
        "lineItem": {
         "sku": "P4-0062"
        }
       }
      ]
     }
    }
   ],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/4",
   "name": "#1005",
   "processedAt": "2026-11-16T10:47:07Z",
   "updatedAt": "2026-11-19T17:34:52Z",
   "cancelledAt": null,
   "displayFinancialStatus": "REFUNDED",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "168.46",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 0,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0062",
      "title": "Summit Camp Stove",
      "currentQuantity": 0,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "168.46",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [
    {
     "createdAt": "2026-11-19T17:34:52Z",
     "note": "Igniter failed",
     "totalRefundedSet": {
      "shopMoney": {
       "amount": "168.46",
       "currencyCode": "USD"
      }
     },
     "refundLineItems": {
      "nodes": [
       {
        "quantity": 1,
        "restockType": "NO_RESTOCK",
        "lineItem": {
         "sku": "P4-0062"
        }
       }
      ]
     }
    }
   ],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/5",
   "name": "#1006",
   "processedAt": "2026-11-15T02:08:01Z",
   "updatedAt": "2026-11-19T17:34:54Z",
   "cancelledAt": null,
   "displayFinancialStatus": "REFUNDED",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "168.46",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 0,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0062",
      "title": "Summit Camp Stove",
      "currentQuantity": 0,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "168.46",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [
    {
     "createdAt": "2026-11-19T17:34:54Z",
     "note": "Igniter failed",
     "totalRefundedSet": {
      "shopMoney": {
       "amount": "168.46",
       "currencyCode": "USD"
      }
     },
     "refundLineItems": {
      "nodes": [
       {
        "quantity": 1,
        "restockType": "NO_RESTOCK",
        "lineItem": {
         "sku": "P4-0062"
        }
       }
      ]
     }
    }
   ],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/6",
   "name": "#1007",
   "processedAt": "2026-11-17T05:10:04Z",
   "updatedAt": "2026-11-19T17:34:55Z",
   "cancelledAt": null,
   "displayFinancialStatus": "REFUNDED",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "168.46",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 0,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0062",
      "title": "Summit Camp Stove",
      "currentQuantity": 0,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "168.46",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [
    {
     "createdAt": "2026-11-19T17:34:55Z",
     "note": "Igniter failed",
     "totalRefundedSet": {
      "shopMoney": {
       "amount": "168.46",
       "currencyCode": "USD"
      }
     },
     "refundLineItems": {
      "nodes": [
       {
        "quantity": 1,
        "restockType": "NO_RESTOCK",
        "lineItem": {
         "sku": "P4-0062"
        }
       }
      ]
     }
    }
   ],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/7",
   "name": "#1008",
   "processedAt": "2026-11-14T16:03:14Z",
   "updatedAt": "2026-11-19T17:34:56Z",
   "cancelledAt": null,
   "displayFinancialStatus": "REFUNDED",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "168.46",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 0,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0062",
      "title": "Summit Camp Stove",
      "currentQuantity": 0,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "168.46",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [
    {
     "createdAt": "2026-11-19T17:34:56Z",
     "note": "Igniter failed",
     "totalRefundedSet": {
      "shopMoney": {
       "amount": "168.46",
       "currencyCode": "USD"
      }
     },
     "refundLineItems": {
      "nodes": [
       {
        "quantity": 1,
        "restockType": "NO_RESTOCK",
        "lineItem": {
         "sku": "P4-0062"
        }
       }
      ]
     }
    }
   ],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/8",
   "name": "#1009",
   "processedAt": "2026-11-17T00:20:31Z",
   "updatedAt": "2026-11-19T17:34:58Z",
   "cancelledAt": null,
   "displayFinancialStatus": "REFUNDED",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "168.46",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 0,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0062",
      "title": "Summit Camp Stove",
      "currentQuantity": 0,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "168.46",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [
    {
     "createdAt": "2026-11-19T17:34:57Z",
     "note": "Igniter failed",
     "totalRefundedSet": {
      "shopMoney": {
       "amount": "168.46",
       "currencyCode": "USD"
      }
     },
     "refundLineItems": {
      "nodes": [
       {
        "quantity": 1,
        "restockType": "NO_RESTOCK",
        "lineItem": {
         "sku": "P4-0062"
        }
       }
      ]
     }
    }
   ],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/9",
   "name": "#1010",
   "processedAt": "2026-11-14T08:31:39Z",
   "updatedAt": "2026-11-19T17:34:59Z",
   "cancelledAt": null,
   "displayFinancialStatus": "REFUNDED",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "168.46",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 0,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0062",
      "title": "Summit Camp Stove",
      "currentQuantity": 0,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "168.46",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [
    {
     "createdAt": "2026-11-19T17:34:59Z",
     "note": "Igniter failed",
     "totalRefundedSet": {
      "shopMoney": {
       "amount": "168.46",
       "currencyCode": "USD"
      }
     },
     "refundLineItems": {
      "nodes": [
       {
        "quantity": 1,
        "restockType": "NO_RESTOCK",
        "lineItem": {
         "sku": "P4-0062"
        }
       }
      ]
     }
    }
   ],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/10",
   "name": "#1011",
   "processedAt": "2026-11-13T11:05:05Z",
   "updatedAt": "2026-11-19T17:35:00Z",
   "cancelledAt": null,
   "displayFinancialStatus": "REFUNDED",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "168.46",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 0,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0062",
      "title": "Summit Camp Stove",
      "currentQuantity": 0,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "168.46",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [
    {
     "createdAt": "2026-11-19T17:35:00Z",
     "note": "Igniter failed",
     "totalRefundedSet": {
      "shopMoney": {
       "amount": "168.46",
       "currencyCode": "USD"
      }
     },
     "refundLineItems": {
      "nodes": [
       {
        "quantity": 1,
        "restockType": "NO_RESTOCK",
        "lineItem": {
         "sku": "P4-0062"
        }
       }
      ]
     }
    }
   ],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/11",
   "name": "#1012",
   "processedAt": "2026-11-13T00:46:48Z",
   "updatedAt": "2026-11-19T17:35:01Z",
   "cancelledAt": null,
   "displayFinancialStatus": "REFUNDED",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "168.46",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 0,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0062",
      "title": "Summit Camp Stove",
      "currentQuantity": 0,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "168.46",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [
    {
     "createdAt": "2026-11-19T17:35:01Z",
     "note": "Igniter failed",
     "totalRefundedSet": {
      "shopMoney": {
       "amount": "168.46",
       "currencyCode": "USD"
      }
     },
     "refundLineItems": {
      "nodes": [
       {
        "quantity": 1,
        "restockType": "NO_RESTOCK",
        "lineItem": {
         "sku": "P4-0062"
        }
       }
      ]
     }
    }
   ],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/12",
   "name": "#1013",
   "processedAt": "2026-11-11T19:28:21Z",
   "updatedAt": "2026-11-19T17:35:03Z",
   "cancelledAt": null,
   "displayFinancialStatus": "REFUNDED",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "168.46",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 0,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0062",
      "title": "Summit Camp Stove",
      "currentQuantity": 0,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "168.46",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [
    {
     "createdAt": "2026-11-19T17:35:03Z",
     "note": "Igniter failed",
     "totalRefundedSet": {
      "shopMoney": {
       "amount": "168.46",
       "currencyCode": "USD"
      }
     },
     "refundLineItems": {
      "nodes": [
       {
        "quantity": 1,
        "restockType": "NO_RESTOCK",
        "lineItem": {
         "sku": "P4-0062"
        }
       }
      ]
     }
    }
   ],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/13",
   "name": "#1014",
   "processedAt": "2026-11-15T02:00:33Z",
   "updatedAt": "2026-11-19T17:35:04Z",
   "cancelledAt": null,
   "displayFinancialStatus": "REFUNDED",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "168.46",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 0,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0062",
      "title": "Summit Camp Stove",
      "currentQuantity": 0,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "168.46",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [
    {
     "createdAt": "2026-11-19T17:35:04Z",
     "note": "Igniter failed",
     "totalRefundedSet": {
      "shopMoney": {
       "amount": "168.46",
       "currencyCode": "USD"
      }
     },
     "refundLineItems": {
      "nodes": [
       {
        "quantity": 1,
        "restockType": "NO_RESTOCK",
        "lineItem": {
         "sku": "P4-0062"
        }
       }
      ]
     }
    }
   ],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/14",
   "name": "#1015",
   "processedAt": "2026-11-13T07:42:58Z",
   "updatedAt": "2026-11-19T17:35:05Z",
   "cancelledAt": null,
   "displayFinancialStatus": "REFUNDED",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "168.46",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 0,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0062",
      "title": "Summit Camp Stove",
      "currentQuantity": 0,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "168.46",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [
    {
     "createdAt": "2026-11-19T17:35:05Z",
     "note": "Igniter failed",
     "totalRefundedSet": {
      "shopMoney": {
       "amount": "168.46",
       "currencyCode": "USD"
      }
     },
     "refundLineItems": {
      "nodes": [
       {
        "quantity": 1,
        "restockType": "NO_RESTOCK",
        "lineItem": {
         "sku": "P4-0062"
        }
       }
      ]
     }
    }
   ],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/15",
   "name": "#1016",
   "processedAt": "2026-11-14T09:06:02Z",
   "updatedAt": "2026-11-19T17:35:07Z",
   "cancelledAt": null,
   "displayFinancialStatus": "REFUNDED",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "168.46",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 0,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0062",
      "title": "Summit Camp Stove",
      "currentQuantity": 0,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "168.46",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [
    {
     "createdAt": "2026-11-19T17:35:07Z",
     "note": "Igniter failed",
     "totalRefundedSet": {
      "shopMoney": {
       "amount": "168.46",
       "currencyCode": "USD"
      }
     },
     "refundLineItems": {
      "nodes": [
       {
        "quantity": 1,
        "restockType": "NO_RESTOCK",
        "lineItem": {
         "sku": "P4-0062"
        }
       }
      ]
     }
    }
   ],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/16",
   "name": "#1017",
   "processedAt": "2026-11-15T20:09:52Z",
   "updatedAt": "2026-11-19T17:35:08Z",
   "cancelledAt": null,
   "displayFinancialStatus": "REFUNDED",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "168.46",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 0,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0062",
      "title": "Summit Camp Stove",
      "currentQuantity": 0,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "168.46",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [
    {
     "createdAt": "2026-11-19T17:35:08Z",
     "note": "Igniter failed",
     "totalRefundedSet": {
      "shopMoney": {
       "amount": "168.46",
       "currencyCode": "USD"
      }
     },
     "refundLineItems": {
      "nodes": [
       {
        "quantity": 1,
        "restockType": "NO_RESTOCK",
        "lineItem": {
         "sku": "P4-0062"
        }
       }
      ]
     }
    }
   ],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/17",
   "name": "#1018",
   "processedAt": "2026-11-11T22:20:08Z",
   "updatedAt": "2026-11-19T17:35:09Z",
   "cancelledAt": null,
   "displayFinancialStatus": "REFUNDED",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "168.46",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 0,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0062",
      "title": "Summit Camp Stove",
      "currentQuantity": 0,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "168.46",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [
    {
     "createdAt": "2026-11-19T17:35:09Z",
     "note": "Igniter failed",
     "totalRefundedSet": {
      "shopMoney": {
       "amount": "168.46",
       "currencyCode": "USD"
      }
     },
     "refundLineItems": {
      "nodes": [
       {
        "quantity": 1,
        "restockType": "NO_RESTOCK",
        "lineItem": {
         "sku": "P4-0062"
        }
       }
      ]
     }
    }
   ],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/18",
   "name": "#1019",
   "processedAt": "2026-11-05T19:24:36Z",
   "updatedAt": "2026-11-19T17:35:11Z",
   "cancelledAt": null,
   "displayFinancialStatus": "REFUNDED",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "168.46",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 0,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0062",
      "title": "Summit Camp Stove",
      "currentQuantity": 0,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "168.46",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [
    {
     "createdAt": "2026-11-19T17:35:11Z",
     "note": "Igniter failed",
     "totalRefundedSet": {
      "shopMoney": {
       "amount": "168.46",
       "currencyCode": "USD"
      }
     },
     "refundLineItems": {
      "nodes": [
       {
        "quantity": 1,
        "restockType": "NO_RESTOCK",
        "lineItem": {
         "sku": "P4-0062"
        }
       }
      ]
     }
    }
   ],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/19",
   "name": "#1020",
   "processedAt": "2026-11-09T10:03:55Z",
   "updatedAt": "2026-11-19T17:35:12Z",
   "cancelledAt": null,
   "displayFinancialStatus": "REFUNDED",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "168.46",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 0,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0062",
      "title": "Summit Camp Stove",
      "currentQuantity": 0,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "168.46",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [
    {
     "createdAt": "2026-11-19T17:35:12Z",
     "note": "Igniter failed",
     "totalRefundedSet": {
      "shopMoney": {
       "amount": "168.46",
       "currencyCode": "USD"
      }
     },
     "refundLineItems": {
      "nodes": [
       {
        "quantity": 1,
        "restockType": "NO_RESTOCK",
        "lineItem": {
         "sku": "P4-0062"
        }
       }
      ]
     }
    }
   ],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/20",
   "name": "#1021",
   "processedAt": "2026-11-08T05:48:54Z",
   "updatedAt": "2026-11-19T17:35:13Z",
   "cancelledAt": null,
   "displayFinancialStatus": "REFUNDED",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "168.46",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 0,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0062",
      "title": "Summit Camp Stove",
      "currentQuantity": 0,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "168.46",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [
    {
     "createdAt": "2026-11-19T17:35:13Z",
     "note": "Igniter failed",
     "totalRefundedSet": {
      "shopMoney": {
       "amount": "168.46",
       "currencyCode": "USD"
      }
     },
     "refundLineItems": {
      "nodes": [
       {
        "quantity": 1,
        "restockType": "NO_RESTOCK",
        "lineItem": {
         "sku": "P4-0062"
        }
       }
      ]
     }
    }
   ],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/21",
   "name": "#1022",
   "processedAt": "2026-11-10T12:19:31Z",
   "updatedAt": "2026-11-19T17:35:14Z",
   "cancelledAt": null,
   "displayFinancialStatus": "REFUNDED",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "168.46",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 0,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0062",
      "title": "Summit Camp Stove",
      "currentQuantity": 0,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "168.46",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [
    {
     "createdAt": "2026-11-19T17:35:14Z",
     "note": "Igniter failed",
     "totalRefundedSet": {
      "shopMoney": {
       "amount": "168.46",
       "currencyCode": "USD"
      }
     },
     "refundLineItems": {
      "nodes": [
       {
        "quantity": 1,
        "restockType": "NO_RESTOCK",
        "lineItem": {
         "sku": "P4-0062"
        }
       }
      ]
     }
    }
   ],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/22",
   "name": "#1023",
   "processedAt": "2026-11-03T22:13:42Z",
   "updatedAt": "2026-11-19T17:35:16Z",
   "cancelledAt": null,
   "displayFinancialStatus": "REFUNDED",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "168.46",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 0,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0062",
      "title": "Summit Camp Stove",
      "currentQuantity": 0,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "168.46",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [
    {
     "createdAt": "2026-11-19T17:35:16Z",
     "note": "Igniter failed",
     "totalRefundedSet": {
      "shopMoney": {
       "amount": "168.46",
       "currencyCode": "USD"
      }
     },
     "refundLineItems": {
      "nodes": [
       {
        "quantity": 1,
        "restockType": "NO_RESTOCK",
        "lineItem": {
         "sku": "P4-0062"
        }
       }
      ]
     }
    }
   ],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/23",
   "name": "#1024",
   "processedAt": "2026-10-31T13:18:06Z",
   "updatedAt": "2026-11-19T17:35:17Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "IN_PROGRESS",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "216.24",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0089",
      "title": "Ridge Compass",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "216.24",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": [
     {
      "name": "#1024-R1",
      "status": "OPEN",
      "createdAt": "2026-11-19T17:35:17Z",
      "returnLineItems": {
       "nodes": [
        {
         "quantity": 1,
         "unprocessedQuantity": 1,
         "returnReasonDefinition": {
          "name": "Damaged or defective"
         },
         "fulfillmentLineItem": {
          "lineItem": {
           "sku": "P4-0089"
          }
         }
        }
       ]
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Order/24",
   "name": "#1025",
   "processedAt": "2026-11-02T09:07:32Z",
   "updatedAt": "2026-11-19T17:35:17Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "IN_PROGRESS",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "216.24",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0089",
      "title": "Ridge Compass",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "216.24",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": [
     {
      "name": "#1025-R1",
      "status": "OPEN",
      "createdAt": "2026-11-19T17:35:18Z",
      "returnLineItems": {
       "nodes": [
        {
         "quantity": 1,
         "unprocessedQuantity": 1,
         "returnReasonDefinition": {
          "name": "Damaged or defective"
         },
         "fulfillmentLineItem": {
          "lineItem": {
           "sku": "P4-0089"
          }
         }
        }
       ]
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Order/25",
   "name": "#1026",
   "processedAt": "2026-10-30T00:29:10Z",
   "updatedAt": "2026-11-19T17:35:18Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "IN_PROGRESS",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "216.24",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0089",
      "title": "Ridge Compass",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "216.24",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": [
     {
      "name": "#1026-R1",
      "status": "OPEN",
      "createdAt": "2026-11-19T17:35:18Z",
      "returnLineItems": {
       "nodes": [
        {
         "quantity": 1,
         "unprocessedQuantity": 1,
         "returnReasonDefinition": {
          "name": "Damaged or defective"
         },
         "fulfillmentLineItem": {
          "lineItem": {
           "sku": "P4-0089"
          }
         }
        }
       ]
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Order/26",
   "name": "#1027",
   "processedAt": "2026-10-22T06:20:42Z",
   "updatedAt": "2026-11-19T17:35:19Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "IN_PROGRESS",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "216.24",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0089",
      "title": "Ridge Compass",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "216.24",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": [
     {
      "name": "#1027-R1",
      "status": "OPEN",
      "createdAt": "2026-11-19T17:35:19Z",
      "returnLineItems": {
       "nodes": [
        {
         "quantity": 1,
         "unprocessedQuantity": 1,
         "returnReasonDefinition": {
          "name": "Damaged or defective"
         },
         "fulfillmentLineItem": {
          "lineItem": {
           "sku": "P4-0089"
          }
         }
        }
       ]
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Order/27",
   "name": "#1028",
   "processedAt": "2026-10-14T11:16:39Z",
   "updatedAt": "2026-11-19T17:35:20Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "IN_PROGRESS",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "216.24",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0089",
      "title": "Ridge Compass",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "216.24",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": [
     {
      "name": "#1028-R1",
      "status": "OPEN",
      "createdAt": "2026-11-19T17:35:20Z",
      "returnLineItems": {
       "nodes": [
        {
         "quantity": 1,
         "unprocessedQuantity": 1,
         "returnReasonDefinition": {
          "name": "Damaged or defective"
         },
         "fulfillmentLineItem": {
          "lineItem": {
           "sku": "P4-0089"
          }
         }
        }
       ]
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Order/28",
   "name": "#1029",
   "processedAt": "2026-11-04T22:46:40Z",
   "updatedAt": "2026-11-19T17:35:21Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "IN_PROGRESS",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "216.24",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0089",
      "title": "Ridge Compass",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "216.24",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": [
     {
      "name": "#1029-R1",
      "status": "OPEN",
      "createdAt": "2026-11-19T17:35:21Z",
      "returnLineItems": {
       "nodes": [
        {
         "quantity": 1,
         "unprocessedQuantity": 1,
         "returnReasonDefinition": {
          "name": "Damaged or defective"
         },
         "fulfillmentLineItem": {
          "lineItem": {
           "sku": "P4-0089"
          }
         }
        }
       ]
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Order/29",
   "name": "#1030",
   "processedAt": "2026-11-02T14:02:36Z",
   "updatedAt": "2026-11-19T17:35:22Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "IN_PROGRESS",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "216.24",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0089",
      "title": "Ridge Compass",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "216.24",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": [
     {
      "name": "#1030-R1",
      "status": "OPEN",
      "createdAt": "2026-11-19T17:35:22Z",
      "returnLineItems": {
       "nodes": [
        {
         "quantity": 1,
         "unprocessedQuantity": 1,
         "returnReasonDefinition": {
          "name": "Damaged or defective"
         },
         "fulfillmentLineItem": {
          "lineItem": {
           "sku": "P4-0089"
          }
         }
        }
       ]
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Order/30",
   "name": "#1031",
   "processedAt": "2026-11-07T13:34:50Z",
   "updatedAt": "2026-11-19T17:35:22Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "IN_PROGRESS",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "216.24",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0089",
      "title": "Ridge Compass",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "216.24",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": [
     {
      "name": "#1031-R1",
      "status": "OPEN",
      "createdAt": "2026-11-19T17:35:22Z",
      "returnLineItems": {
       "nodes": [
        {
         "quantity": 1,
         "unprocessedQuantity": 1,
         "returnReasonDefinition": {
          "name": "Damaged or defective"
         },
         "fulfillmentLineItem": {
          "lineItem": {
           "sku": "P4-0089"
          }
         }
        }
       ]
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Order/31",
   "name": "#1032",
   "processedAt": "2026-10-23T20:33:15Z",
   "updatedAt": "2026-11-19T17:35:23Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "IN_PROGRESS",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "216.24",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0089",
      "title": "Ridge Compass",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "216.24",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": [
     {
      "name": "#1032-R1",
      "status": "OPEN",
      "createdAt": "2026-11-19T17:35:23Z",
      "returnLineItems": {
       "nodes": [
        {
         "quantity": 1,
         "unprocessedQuantity": 1,
         "returnReasonDefinition": {
          "name": "Damaged or defective"
         },
         "fulfillmentLineItem": {
          "lineItem": {
           "sku": "P4-0089"
          }
         }
        }
       ]
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Order/32",
   "name": "#1033",
   "processedAt": "2026-10-22T13:10:51Z",
   "updatedAt": "2026-11-19T17:35:24Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "IN_PROGRESS",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "216.24",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0089",
      "title": "Ridge Compass",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "216.24",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": [
     {
      "name": "#1033-R1",
      "status": "OPEN",
      "createdAt": "2026-11-19T17:35:24Z",
      "returnLineItems": {
       "nodes": [
        {
         "quantity": 1,
         "unprocessedQuantity": 1,
         "returnReasonDefinition": {
          "name": "Damaged or defective"
         },
         "fulfillmentLineItem": {
          "lineItem": {
           "sku": "P4-0089"
          }
         }
        }
       ]
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Order/33",
   "name": "#1034",
   "processedAt": "2026-10-29T16:00:20Z",
   "updatedAt": "2026-11-19T17:35:25Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "IN_PROGRESS",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "216.24",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0089",
      "title": "Ridge Compass",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "216.24",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": [
     {
      "name": "#1034-R1",
      "status": "OPEN",
      "createdAt": "2026-11-19T17:35:25Z",
      "returnLineItems": {
       "nodes": [
        {
         "quantity": 1,
         "unprocessedQuantity": 1,
         "returnReasonDefinition": {
          "name": "Damaged or defective"
         },
         "fulfillmentLineItem": {
          "lineItem": {
           "sku": "P4-0089"
          }
         }
        }
       ]
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Order/34",
   "name": "#1035",
   "processedAt": "2026-11-02T10:29:36Z",
   "updatedAt": "2026-11-19T17:24:16Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "69.06",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/35",
   "name": "#1036",
   "processedAt": "2026-11-06T18:49:51Z",
   "updatedAt": "2026-11-19T17:24:17Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "69.06",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/36",
   "name": "#1037",
   "processedAt": "2026-11-11T20:51:14Z",
   "updatedAt": "2026-11-19T17:24:19Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "103.59",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 3,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/37",
   "name": "#1038",
   "processedAt": "2026-10-24T23:12:51Z",
   "updatedAt": "2026-11-19T17:25:23Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "69.06",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/38",
   "name": "#1039",
   "processedAt": "2026-10-21T10:11:21Z",
   "updatedAt": "2026-11-19T17:25:24Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "103.59",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 3,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/39",
   "name": "#1040",
   "processedAt": "2026-11-11T07:15:20Z",
   "updatedAt": "2026-11-19T17:25:26Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "103.59",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 3,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/40",
   "name": "#1041",
   "processedAt": "2026-10-26T14:39:09Z",
   "updatedAt": "2026-11-19T17:25:27Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "69.06",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/41",
   "name": "#1042",
   "processedAt": "2026-11-01T15:40:44Z",
   "updatedAt": "2026-11-19T17:25:29Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "69.06",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/42",
   "name": "#1043",
   "processedAt": "2026-10-26T04:08:05Z",
   "updatedAt": "2026-11-19T17:26:33Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "69.06",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/43",
   "name": "#1044",
   "processedAt": "2026-10-27T03:36:18Z",
   "updatedAt": "2026-11-19T17:26:35Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "103.59",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 3,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/44",
   "name": "#1045",
   "processedAt": "2026-11-04T13:39:15Z",
   "updatedAt": "2026-11-19T17:26:36Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "69.06",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/45",
   "name": "#1046",
   "processedAt": "2026-11-11T09:47:31Z",
   "updatedAt": "2026-11-19T17:26:38Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "69.06",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/46",
   "name": "#1047",
   "processedAt": "2026-10-27T19:53:35Z",
   "updatedAt": "2026-11-19T17:26:39Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "103.59",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 3,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/47",
   "name": "#1048",
   "processedAt": "2026-10-28T15:41:26Z",
   "updatedAt": "2026-11-19T17:27:43Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "69.06",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/48",
   "name": "#1049",
   "processedAt": "2026-11-08T11:41:23Z",
   "updatedAt": "2026-11-19T17:27:44Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "103.59",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 3,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/49",
   "name": "#1050",
   "processedAt": "2026-11-11T22:40:02Z",
   "updatedAt": "2026-11-19T17:27:46Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "69.06",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/50",
   "name": "#1051",
   "processedAt": "2026-11-09T17:24:07Z",
   "updatedAt": "2026-11-19T17:27:47Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "103.59",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 3,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/51",
   "name": "#1052",
   "processedAt": "2026-10-28T20:31:23Z",
   "updatedAt": "2026-11-19T17:27:49Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "103.59",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 3,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/52",
   "name": "#1053",
   "processedAt": "2026-10-28T08:13:04Z",
   "updatedAt": "2026-11-19T17:28:53Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "103.59",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 3,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/53",
   "name": "#1054",
   "processedAt": "2026-11-07T20:43:44Z",
   "updatedAt": "2026-11-19T17:28:55Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "69.06",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/54",
   "name": "#1055",
   "processedAt": "2026-11-13T06:32:09Z",
   "updatedAt": "2026-11-19T17:28:56Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "103.59",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 3,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/55",
   "name": "#1056",
   "processedAt": "2026-11-18T13:17:39Z",
   "updatedAt": "2026-11-19T17:28:57Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "UNFULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "69.06",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 2,
      "unfulfilledQuantity": 2,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/56",
   "name": "#1057",
   "processedAt": "2026-10-26T21:57:55Z",
   "updatedAt": "2026-11-19T17:28:59Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "103.59",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 3,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/57",
   "name": "#1058",
   "processedAt": "2026-11-13T20:26:59Z",
   "updatedAt": "2026-11-19T17:30:03Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "69.06",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/58",
   "name": "#1059",
   "processedAt": "2026-10-27T06:59:57Z",
   "updatedAt": "2026-11-19T17:30:05Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "69.06",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/59",
   "name": "#1060",
   "processedAt": "2026-11-16T20:00:51Z",
   "updatedAt": "2026-11-19T17:30:07Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "69.06",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/60",
   "name": "#1061",
   "processedAt": "2026-11-09T08:16:43Z",
   "updatedAt": "2026-11-19T17:30:08Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "103.59",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 3,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/61",
   "name": "#1062",
   "processedAt": "2026-10-28T14:14:50Z",
   "updatedAt": "2026-11-19T17:30:09Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "69.06",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/62",
   "name": "#1063",
   "processedAt": "2026-11-09T14:51:28Z",
   "updatedAt": "2026-11-19T17:31:14Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "69.06",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/63",
   "name": "#1064",
   "processedAt": "2026-11-06T08:23:59Z",
   "updatedAt": "2026-11-19T17:31:15Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "103.59",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 3,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/64",
   "name": "#1065",
   "processedAt": "2026-11-06T20:06:49Z",
   "updatedAt": "2026-11-19T17:31:16Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "69.06",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/65",
   "name": "#1066",
   "processedAt": "2026-10-20T22:40:09Z",
   "updatedAt": "2026-11-19T17:31:18Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "69.06",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/66",
   "name": "#1067",
   "processedAt": "2026-11-14T13:40:03Z",
   "updatedAt": "2026-11-19T17:31:19Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "69.06",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/67",
   "name": "#1068",
   "processedAt": "2026-10-21T01:52:41Z",
   "updatedAt": "2026-11-19T17:32:24Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "69.06",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/68",
   "name": "#1069",
   "processedAt": "2026-11-17T02:23:03Z",
   "updatedAt": "2026-11-19T17:32:25Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "103.59",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 3,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/69",
   "name": "#1070",
   "processedAt": "2026-10-31T07:49:50Z",
   "updatedAt": "2026-11-19T17:32:27Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "103.59",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 3,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/70",
   "name": "#1071",
   "processedAt": "2026-11-02T23:30:22Z",
   "updatedAt": "2026-11-19T17:32:29Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "103.59",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 3,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/71",
   "name": "#1072",
   "processedAt": "2026-11-02T22:30:35Z",
   "updatedAt": "2026-11-19T17:32:30Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "69.06",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/72",
   "name": "#1073",
   "processedAt": "2026-11-05T00:45:15Z",
   "updatedAt": "2026-11-19T17:33:35Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "69.06",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/73",
   "name": "#1074",
   "processedAt": "2026-11-15T21:56:11Z",
   "updatedAt": "2026-11-19T17:33:37Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "103.59",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0013",
      "title": "Lite Gaiters",
      "currentQuantity": 3,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.53",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/74",
   "name": "#1075",
   "processedAt": "2026-11-16T22:54:18Z",
   "updatedAt": "2026-11-19T17:33:38Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "168.45",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0038",
      "title": "Trail Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "168.45",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/75",
   "name": "#1076",
   "processedAt": "2026-11-14T18:59:15Z",
   "updatedAt": "2026-11-19T17:33:40Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "168.45",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0038",
      "title": "Trail Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "168.45",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/76",
   "name": "#1077",
   "processedAt": "2026-11-07T09:52:18Z",
   "updatedAt": "2026-11-19T17:33:41Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "168.45",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0038",
      "title": "Trail Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "168.45",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/77",
   "name": "#1078",
   "processedAt": "2026-11-13T18:09:50Z",
   "updatedAt": "2026-11-19T17:34:45Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "168.45",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0038",
      "title": "Trail Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "168.45",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/78",
   "name": "#1079",
   "processedAt": "2026-11-12T19:24:22Z",
   "updatedAt": "2026-11-19T17:34:47Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "168.45",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0038",
      "title": "Trail Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "168.45",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/79",
   "name": "#1080",
   "processedAt": "2026-11-14T09:05:31Z",
   "updatedAt": "2026-11-19T17:34:48Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "168.45",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0038",
      "title": "Trail Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "168.45",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/80",
   "name": "#1081",
   "processedAt": "2026-08-26T08:01:03Z",
   "updatedAt": "2026-11-19T17:35:27Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "151.83",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0041",
      "title": "Trail Hammock",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "151.83",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/81",
   "name": "#1082",
   "processedAt": "2026-10-10T20:48:50Z",
   "updatedAt": "2026-11-19T17:35:29Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "232.41",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0132",
      "title": "Forest Fleece",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "112.67",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0039",
      "title": "Trail Camp Chair",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "95.99",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0070",
      "title": "Basecamp Cookset",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "23.75",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/82",
   "name": "#1083",
   "processedAt": "2026-10-28T00:11:41Z",
   "updatedAt": "2026-11-19T17:35:46Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "17.96",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0071",
      "title": "Basecamp Hammock",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "17.96",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/83",
   "name": "#1084",
   "processedAt": "2026-10-03T02:09:55Z",
   "updatedAt": "2026-11-19T17:35:48Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "344.76",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/84",
   "name": "#1085",
   "processedAt": "2026-10-15T11:28:45Z",
   "updatedAt": "2026-11-19T17:35:49Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "94.52",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0095",
      "title": "Alpine Backpack",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "94.52",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/85",
   "name": "#1086",
   "processedAt": "2026-09-30T23:00:36Z",
   "updatedAt": "2026-11-19T17:35:50Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "578.3",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0083",
      "title": "Ridge Rain Jacket",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "212.64",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0019",
      "title": "Pro Headlamp",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "153.02",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/86",
   "name": "#1087",
   "processedAt": "2026-10-11T01:47:28Z",
   "updatedAt": "2026-11-19T17:35:52Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "407.56",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0016",
      "title": "Pro Tent",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "203.78",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/87",
   "name": "#1088",
   "processedAt": "2026-09-15T10:08:01Z",
   "updatedAt": "2026-11-19T17:36:57Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "204.08",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0026",
      "title": "Pro Hammock",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "204.08",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/88",
   "name": "#1089",
   "processedAt": "2026-10-12T09:19:08Z",
   "updatedAt": "2026-11-19T17:36:58Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "542.4",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 4,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0128",
      "title": "Forest Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "184.11",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0136",
      "title": "Coast Tent",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "139.67",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0059",
      "title": "Summit Compass",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "109.31",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/89",
   "name": "#1090",
   "processedAt": "2026-10-07T21:20:28Z",
   "updatedAt": "2026-11-19T17:36:59Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "199.01",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0131",
      "title": "Forest Hammock",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "199.01",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/90",
   "name": "#1091",
   "processedAt": "2026-09-27T05:19:08Z",
   "updatedAt": "2026-11-19T17:37:01Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "85.22",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0072",
      "title": "Basecamp Fleece",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "85.22",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/91",
   "name": "#1092",
   "processedAt": "2026-08-24T16:19:07Z",
   "updatedAt": "2026-11-19T17:37:03Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "172.38",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/92",
   "name": "#1093",
   "processedAt": "2026-10-26T10:26:31Z",
   "updatedAt": "2026-11-19T17:38:07Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "359.07",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0132",
      "title": "Forest Fleece",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "112.67",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0082",
      "title": "Ridge Trekking Poles",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "123.2",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/93",
   "name": "#1094",
   "processedAt": "2026-10-01T22:28:23Z",
   "updatedAt": "2026-11-19T17:38:09Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "357.67",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0148",
      "title": "Coast Gaiters",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "185.29",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/94",
   "name": "#1095",
   "processedAt": "2026-11-07T13:17:45Z",
   "updatedAt": "2026-11-19T17:38:10Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "43.77",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0133",
      "title": "Forest Gaiters",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "43.77",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/95",
   "name": "#1096",
   "processedAt": "2026-08-27T18:24:59Z",
   "updatedAt": "2026-11-19T17:38:11Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "131.69",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0147",
      "title": "Coast Fleece",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "131.69",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/96",
   "name": "#1097",
   "processedAt": "2026-08-25T22:46:42Z",
   "updatedAt": "2026-11-19T17:38:14Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "586.25",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 4,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0131",
      "title": "Forest Hammock",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "199.01",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0111",
      "title": "Canyon Water Filter",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "75.56",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0132",
      "title": "Forest Fleece",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "112.67",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/97",
   "name": "#1098",
   "processedAt": "2026-09-09T14:35:51Z",
   "updatedAt": "2026-11-19T17:39:18Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "75.56",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0111",
      "title": "Canyon Water Filter",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "75.56",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/98",
   "name": "#1099",
   "processedAt": "2026-09-19T07:55:02Z",
   "updatedAt": "2026-11-19T17:39:20Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "196.31",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0048",
      "title": "Summit Stove",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "196.31",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/99",
   "name": "#1100",
   "processedAt": "2026-09-06T18:38:51Z",
   "updatedAt": "2026-11-19T17:39:21Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "237.92",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0125",
      "title": "Forest Backpack",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "136.06",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0120",
      "title": "Canyon Dry Bag",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "101.86",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/100",
   "name": "#1101",
   "processedAt": "2026-09-14T13:47:32Z",
   "updatedAt": "2026-11-19T17:39:23Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "501.51",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0085",
      "title": "Ridge Cookset",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "156.75",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/101",
   "name": "#1102",
   "processedAt": "2026-10-09T23:35:06Z",
   "updatedAt": "2026-11-19T17:39:24Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "211.62",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0111",
      "title": "Canyon Water Filter",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "75.56",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0125",
      "title": "Forest Backpack",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "136.06",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/102",
   "name": "#1103",
   "processedAt": "2026-08-26T16:14:14Z",
   "updatedAt": "2026-11-19T17:40:29Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "160.17",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0070",
      "title": "Basecamp Cookset",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "23.75",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0132",
      "title": "Forest Fleece",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "112.67",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/103",
   "name": "#1104",
   "processedAt": "2026-11-01T02:31:29Z",
   "updatedAt": "2026-11-19T17:40:30Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "185.46",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0149",
      "title": "Coast Compass",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "72.79",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0132",
      "title": "Forest Fleece",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "112.67",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/104",
   "name": "#1105",
   "processedAt": "2026-10-31T10:08:30Z",
   "updatedAt": "2026-11-19T17:40:32Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "153.78",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0118",
      "title": "Canyon Gaiters",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "153.78",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/105",
   "name": "#1106",
   "processedAt": "2026-08-23T16:58:39Z",
   "updatedAt": "2026-11-19T17:40:33Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "109.31",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0059",
      "title": "Summit Compass",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "109.31",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/106",
   "name": "#1107",
   "processedAt": "2026-10-25T09:00:37Z",
   "updatedAt": "2026-11-19T17:40:35Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "220.37",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0130",
      "title": "Forest Cookset",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "65.75",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0053",
      "title": "Summit Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "154.62",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/107",
   "name": "#1108",
   "processedAt": "2026-09-26T02:50:05Z",
   "updatedAt": "2026-11-19T17:41:39Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "95.99",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0039",
      "title": "Trail Camp Chair",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "95.99",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/108",
   "name": "#1109",
   "processedAt": "2026-10-26T04:36:28Z",
   "updatedAt": "2026-11-19T17:41:41Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "153.02",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0019",
      "title": "Pro Headlamp",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "153.02",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/109",
   "name": "#1110",
   "processedAt": "2026-08-26T09:34:29Z",
   "updatedAt": "2026-11-19T17:41:42Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "172.38",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/110",
   "name": "#1111",
   "processedAt": "2026-11-17T08:07:53Z",
   "updatedAt": "2026-11-19T17:41:43Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "65.75",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0130",
      "title": "Forest Cookset",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "65.75",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/111",
   "name": "#1112",
   "processedAt": "2026-11-09T17:10:12Z",
   "updatedAt": "2026-11-19T17:41:45Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "284.89",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0002",
      "title": "Lite Sleeping Bag",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "205.42",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0008",
      "title": "Lite Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "79.47",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/112",
   "name": "#1113",
   "processedAt": "2026-10-31T07:28:59Z",
   "updatedAt": "2026-11-19T17:42:50Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "305.85",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0061",
      "title": "Basecamp Tent",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "80.51",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0132",
      "title": "Forest Fleece",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "112.67",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/113",
   "name": "#1114",
   "processedAt": "2026-10-29T01:16:27Z",
   "updatedAt": "2026-11-19T17:42:51Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "47.66",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0011",
      "title": "Lite Hammock",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "47.66",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/114",
   "name": "#1115",
   "processedAt": "2026-09-14T07:39:42Z",
   "updatedAt": "2026-11-19T17:42:53Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "153.02",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0019",
      "title": "Pro Headlamp",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "153.02",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/115",
   "name": "#1116",
   "processedAt": "2026-10-02T12:09:35Z",
   "updatedAt": "2026-11-19T17:42:54Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "109.31",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0059",
      "title": "Summit Compass",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "109.31",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/116",
   "name": "#1117",
   "processedAt": "2026-10-11T05:17:29Z",
   "updatedAt": "2026-11-19T17:42:56Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "43.77",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0133",
      "title": "Forest Gaiters",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "43.77",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/117",
   "name": "#1118",
   "processedAt": "2026-11-18T01:40:07Z",
   "updatedAt": "2026-11-19T17:44:00Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "72.0",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0121",
      "title": "Forest Tent",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "50.18",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0113",
      "title": "Canyon Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "21.82",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/118",
   "name": "#1119",
   "processedAt": "2026-10-18T18:24:33Z",
   "updatedAt": "2026-11-19T17:44:02Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "83.93",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0092",
      "title": "Alpine Sleeping Bag",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "83.93",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/119",
   "name": "#1120",
   "processedAt": "2026-08-27T05:57:20Z",
   "updatedAt": "2026-11-19T17:44:03Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "688.41",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 4,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0019",
      "title": "Pro Headlamp",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "153.02",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0089",
      "title": "Ridge Compass",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "216.24",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0073",
      "title": "Basecamp Gaiters",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "102.91",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/120",
   "name": "#1121",
   "processedAt": "2026-09-21T00:39:50Z",
   "updatedAt": "2026-11-19T17:44:05Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "153.02",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0019",
      "title": "Pro Headlamp",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "153.02",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/121",
   "name": "#1122",
   "processedAt": "2026-10-15T09:06:53Z",
   "updatedAt": "2026-11-19T17:44:06Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "27.96",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0094",
      "title": "Alpine Headlamp",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "27.96",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/122",
   "name": "#1123",
   "processedAt": "2026-10-19T10:52:59Z",
   "updatedAt": "2026-11-19T17:45:11Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "298.3",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0016",
      "title": "Pro Tent",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "203.78",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0095",
      "title": "Alpine Backpack",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "94.52",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/123",
   "name": "#1124",
   "processedAt": "2026-10-02T12:42:37Z",
   "updatedAt": "2026-11-19T17:45:12Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "247.09",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0003",
      "title": "Lite Stove",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "149.78",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0075",
      "title": "Basecamp Dry Bag",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "97.31",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/124",
   "name": "#1125",
   "processedAt": "2026-08-27T10:28:39Z",
   "updatedAt": "2026-11-19T17:45:14Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "215.57",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0116",
      "title": "Canyon Hammock",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "60.95",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0053",
      "title": "Summit Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "154.62",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/125",
   "name": "#1126",
   "processedAt": "2026-09-12T22:29:23Z",
   "updatedAt": "2026-11-19T17:45:15Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "184.11",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0128",
      "title": "Forest Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "184.11",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/126",
   "name": "#1127",
   "processedAt": "2026-09-14T23:27:25Z",
   "updatedAt": "2026-11-19T17:45:16Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "200.34",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0094",
      "title": "Alpine Headlamp",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "27.96",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/127",
   "name": "#1128",
   "processedAt": "2026-09-21T03:15:14Z",
   "updatedAt": "2026-11-19T17:46:21Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "206.54",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0050",
      "title": "Summit Backpack",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "75.41",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0044",
      "title": "Trail Compass",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "42.88",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0140",
      "title": "Coast Backpack",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "88.25",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/128",
   "name": "#1129",
   "processedAt": "2026-11-05T02:51:36Z",
   "updatedAt": "2026-11-19T17:46:23Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "109.31",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0059",
      "title": "Summit Compass",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "109.31",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/129",
   "name": "#1130",
   "processedAt": "2026-10-23T08:16:40Z",
   "updatedAt": "2026-11-19T17:46:24Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "266.25",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0111",
      "title": "Canyon Water Filter",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "75.56",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0035",
      "title": "Trail Backpack",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "190.69",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/130",
   "name": "#1131",
   "processedAt": "2026-09-09T05:52:37Z",
   "updatedAt": "2026-11-19T17:46:26Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "15.95",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0139",
      "title": "Coast Headlamp",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "15.95",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/131",
   "name": "#1132",
   "processedAt": "2026-10-30T17:04:02Z",
   "updatedAt": "2026-11-19T17:46:28Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "486.97",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0067",
      "title": "Basecamp Trekking Poles",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "195.52",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0003",
      "title": "Lite Stove",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "149.78",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0108",
      "title": "Canyon Stove",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "141.67",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/132",
   "name": "#1133",
   "processedAt": "2026-09-19T13:46:57Z",
   "updatedAt": "2026-11-19T17:47:32Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "172.38",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/133",
   "name": "#1134",
   "processedAt": "2026-11-01T11:34:04Z",
   "updatedAt": "2026-11-19T17:47:33Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "97.31",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0075",
      "title": "Basecamp Dry Bag",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "97.31",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/134",
   "name": "#1135",
   "processedAt": "2026-08-22T14:16:24Z",
   "updatedAt": "2026-11-19T17:47:35Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "214.21",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0133",
      "title": "Forest Gaiters",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "43.77",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0072",
      "title": "Basecamp Fleece",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "85.22",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/135",
   "name": "#1136",
   "processedAt": "2026-10-15T07:49:00Z",
   "updatedAt": "2026-11-19T17:47:36Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "60.95",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0116",
      "title": "Canyon Hammock",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "60.95",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/136",
   "name": "#1137",
   "processedAt": "2026-09-05T05:45:45Z",
   "updatedAt": "2026-11-19T17:47:38Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "223.51",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0056",
      "title": "Summit Hammock",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "184.39",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0150",
      "title": "Coast Dry Bag",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "39.12",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/137",
   "name": "#1138",
   "processedAt": "2026-11-09T23:58:44Z",
   "updatedAt": "2026-11-19T17:48:43Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "21.82",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0113",
      "title": "Canyon Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "21.82",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/138",
   "name": "#1139",
   "processedAt": "2026-11-15T11:29:44Z",
   "updatedAt": "2026-11-19T17:48:44Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "141.67",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0108",
      "title": "Canyon Stove",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "141.67",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/139",
   "name": "#1140",
   "processedAt": "2026-10-21T18:28:47Z",
   "updatedAt": "2026-11-19T17:48:46Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "282.16",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0046",
      "title": "Summit Tent",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "141.08",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/140",
   "name": "#1141",
   "processedAt": "2026-11-10T14:53:22Z",
   "updatedAt": "2026-11-19T17:48:48Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "111.59",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0022",
      "title": "Pro Trekking Poles",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "111.59",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/141",
   "name": "#1142",
   "processedAt": "2026-09-11T15:51:09Z",
   "updatedAt": "2026-11-19T17:48:49Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "41.21",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0137",
      "title": "Coast Sleeping Bag",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "41.21",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/142",
   "name": "#1143",
   "processedAt": "2026-09-06T08:28:48Z",
   "updatedAt": "2026-11-19T17:49:53Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "153.02",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0019",
      "title": "Pro Headlamp",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "153.02",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/143",
   "name": "#1144",
   "processedAt": "2026-09-02T21:45:22Z",
   "updatedAt": "2026-11-19T17:49:55Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "208.32",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0037",
      "title": "Trail Trekking Poles",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "208.32",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/144",
   "name": "#1145",
   "processedAt": "2026-09-16T19:30:04Z",
   "updatedAt": "2026-11-19T17:49:56Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "109.31",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0059",
      "title": "Summit Compass",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "109.31",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/145",
   "name": "#1146",
   "processedAt": "2026-09-09T01:04:02Z",
   "updatedAt": "2026-11-19T17:49:58Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "112.67",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0132",
      "title": "Forest Fleece",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "112.67",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/146",
   "name": "#1147",
   "processedAt": "2026-10-05T01:24:19Z",
   "updatedAt": "2026-11-19T17:49:59Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "178.2",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0107",
      "title": "Canyon Sleeping Bag",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "178.2",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/147",
   "name": "#1148",
   "processedAt": "2026-10-04T03:35:07Z",
   "updatedAt": "2026-11-19T17:51:04Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "95.99",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0039",
      "title": "Trail Camp Chair",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "95.99",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/148",
   "name": "#1149",
   "processedAt": "2026-10-07T01:51:32Z",
   "updatedAt": "2026-11-19T17:51:05Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "205.42",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0002",
      "title": "Lite Sleeping Bag",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "205.42",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/149",
   "name": "#1150",
   "processedAt": "2026-10-04T11:36:02Z",
   "updatedAt": "2026-11-19T17:51:06Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "43.43",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0088",
      "title": "Ridge Gaiters",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "43.43",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/150",
   "name": "#1151",
   "processedAt": "2026-08-26T02:03:18Z",
   "updatedAt": "2026-11-19T17:51:08Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "79.15",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0123",
      "title": "Forest Stove",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "79.15",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/151",
   "name": "#1152",
   "processedAt": "2026-11-18T18:36:31Z",
   "updatedAt": "2026-11-19T17:51:09Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "UNFULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "145.08",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0126",
      "title": "Forest Water Filter",
      "currentQuantity": 1,
      "unfulfilledQuantity": 1,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "115.02",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0093",
      "title": "Alpine Stove",
      "currentQuantity": 1,
      "unfulfilledQuantity": 1,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "30.06",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/152",
   "name": "#1153",
   "processedAt": "2026-09-28T17:04:52Z",
   "updatedAt": "2026-11-19T17:52:14Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "54.03",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0106",
      "title": "Canyon Tent",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "54.03",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/153",
   "name": "#1154",
   "processedAt": "2026-11-18T11:42:20Z",
   "updatedAt": "2026-11-19T17:52:15Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "UNFULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "20.56",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0077",
      "title": "Ridge Sleeping Bag",
      "currentQuantity": 1,
      "unfulfilledQuantity": 1,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "20.56",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/154",
   "name": "#1155",
   "processedAt": "2026-09-01T08:33:33Z",
   "updatedAt": "2026-11-19T17:52:16Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "172.38",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/155",
   "name": "#1156",
   "processedAt": "2026-09-29T08:48:44Z",
   "updatedAt": "2026-11-19T17:52:18Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "133.64",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0095",
      "title": "Alpine Backpack",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "94.52",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0150",
      "title": "Coast Dry Bag",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "39.12",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/156",
   "name": "#1157",
   "processedAt": "2026-10-25T18:50:26Z",
   "updatedAt": "2026-11-19T17:52:19Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "204.08",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0026",
      "title": "Pro Hammock",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "204.08",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/157",
   "name": "#1158",
   "processedAt": "2026-10-06T09:30:32Z",
   "updatedAt": "2026-11-19T17:53:24Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "172.38",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/158",
   "name": "#1159",
   "processedAt": "2026-09-04T14:15:07Z",
   "updatedAt": "2026-11-19T17:53:25Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "78.41",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0094",
      "title": "Alpine Headlamp",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "27.96",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0068",
      "title": "Basecamp Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "50.45",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/159",
   "name": "#1160",
   "processedAt": "2026-10-16T06:03:36Z",
   "updatedAt": "2026-11-19T17:53:27Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "16.42",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0054",
      "title": "Summit Camp Chair",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "16.42",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/160",
   "name": "#1161",
   "processedAt": "2026-09-22T01:40:39Z",
   "updatedAt": "2026-11-19T17:53:28Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "95.99",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0039",
      "title": "Trail Camp Chair",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "95.99",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/161",
   "name": "#1162",
   "processedAt": "2026-09-29T16:28:56Z",
   "updatedAt": "2026-11-19T17:53:30Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "502.45",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0142",
      "title": "Coast Trekking Poles",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "94.29",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0026",
      "title": "Pro Hammock",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "204.08",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/162",
   "name": "#1163",
   "processedAt": "2026-11-08T08:06:28Z",
   "updatedAt": "2026-11-19T17:54:34Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "151.83",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0041",
      "title": "Trail Hammock",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "151.83",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/163",
   "name": "#1164",
   "processedAt": "2026-11-17T14:14:18Z",
   "updatedAt": "2026-11-19T17:54:35Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "143.33",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0030",
      "title": "Pro Dry Bag",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "143.33",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/164",
   "name": "#1165",
   "processedAt": "2026-10-14T14:26:54Z",
   "updatedAt": "2026-11-19T17:54:37Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "282.16",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0046",
      "title": "Summit Tent",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "141.08",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/165",
   "name": "#1166",
   "processedAt": "2026-10-29T02:47:51Z",
   "updatedAt": "2026-11-19T17:54:38Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "110.61",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0092",
      "title": "Alpine Sleeping Bag",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "83.93",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0027",
      "title": "Pro Fleece",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "26.68",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/166",
   "name": "#1167",
   "processedAt": "2026-10-23T13:35:50Z",
   "updatedAt": "2026-11-19T17:54:40Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "121.9",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0116",
      "title": "Canyon Hammock",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "60.95",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/167",
   "name": "#1168",
   "processedAt": "2026-10-08T02:13:32Z",
   "updatedAt": "2026-11-19T17:55:44Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "119.42",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0012",
      "title": "Lite Fleece",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.16",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0080",
      "title": "Ridge Backpack",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "85.26",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/168",
   "name": "#1169",
   "processedAt": "2026-10-07T04:10:51Z",
   "updatedAt": "2026-11-19T17:55:46Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "170.84",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0015",
      "title": "Lite Dry Bag",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "127.96",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0044",
      "title": "Trail Compass",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "42.88",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/169",
   "name": "#1170",
   "processedAt": "2026-11-15T06:33:59Z",
   "updatedAt": "2026-11-19T17:55:47Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "97.31",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0075",
      "title": "Basecamp Dry Bag",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "97.31",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/170",
   "name": "#1171",
   "processedAt": "2026-10-27T19:00:17Z",
   "updatedAt": "2026-11-19T17:55:48Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "320.37",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0043",
      "title": "Trail Gaiters",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "147.99",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/171",
   "name": "#1172",
   "processedAt": "2026-09-16T20:39:30Z",
   "updatedAt": "2026-11-19T17:55:50Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "172.38",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/172",
   "name": "#1173",
   "processedAt": "2026-10-08T15:42:04Z",
   "updatedAt": "2026-11-19T17:56:54Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "94.52",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0095",
      "title": "Alpine Backpack",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "94.52",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/173",
   "name": "#1174",
   "processedAt": "2026-10-25T20:46:59Z",
   "updatedAt": "2026-11-19T17:56:55Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "408.16",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0026",
      "title": "Pro Hammock",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "204.08",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/174",
   "name": "#1175",
   "processedAt": "2026-09-11T22:46:58Z",
   "updatedAt": "2026-11-19T17:56:57Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "112.67",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0132",
      "title": "Forest Fleece",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "112.67",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/175",
   "name": "#1176",
   "processedAt": "2026-10-17T14:03:17Z",
   "updatedAt": "2026-11-19T17:56:58Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "95.99",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0039",
      "title": "Trail Camp Chair",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "95.99",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/176",
   "name": "#1177",
   "processedAt": "2026-10-30T13:49:41Z",
   "updatedAt": "2026-11-19T17:56:59Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "214.43",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0084",
      "title": "Ridge Camp Chair",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "33.22",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0043",
      "title": "Trail Gaiters",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "147.99",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/177",
   "name": "#1178",
   "processedAt": "2026-09-04T01:53:02Z",
   "updatedAt": "2026-11-19T17:58:03Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "136.06",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0125",
      "title": "Forest Backpack",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "136.06",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/178",
   "name": "#1179",
   "processedAt": "2026-08-31T22:23:16Z",
   "updatedAt": "2026-11-19T17:58:05Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "34.46",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0017",
      "title": "Pro Sleeping Bag",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.46",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/179",
   "name": "#1180",
   "processedAt": "2026-09-25T14:37:14Z",
   "updatedAt": "2026-11-19T17:58:06Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "211.8",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0146",
      "title": "Coast Hammock",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "58.78",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0019",
      "title": "Pro Headlamp",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "153.02",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/180",
   "name": "#1181",
   "processedAt": "2026-08-31T00:31:35Z",
   "updatedAt": "2026-11-19T17:58:08Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "13.52",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0119",
      "title": "Canyon Compass",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "13.52",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/181",
   "name": "#1182",
   "processedAt": "2026-10-14T03:19:46Z",
   "updatedAt": "2026-11-19T17:58:09Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "79.15",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0123",
      "title": "Forest Stove",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "79.15",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/182",
   "name": "#1183",
   "processedAt": "2026-11-02T19:54:04Z",
   "updatedAt": "2026-11-19T17:59:13Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "374.1",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0052",
      "title": "Summit Trekking Poles",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "187.05",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/183",
   "name": "#1184",
   "processedAt": "2026-09-26T05:05:18Z",
   "updatedAt": "2026-11-19T17:59:15Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "188.07",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0020",
      "title": "Pro Backpack",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "188.07",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/184",
   "name": "#1185",
   "processedAt": "2026-09-12T15:19:03Z",
   "updatedAt": "2026-11-19T17:59:16Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "75.56",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0111",
      "title": "Canyon Water Filter",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "75.56",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/185",
   "name": "#1186",
   "processedAt": "2026-09-02T10:50:13Z",
   "updatedAt": "2026-11-19T17:59:18Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "109.31",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0059",
      "title": "Summit Compass",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "109.31",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/186",
   "name": "#1187",
   "processedAt": "2026-09-10T15:40:05Z",
   "updatedAt": "2026-11-19T17:59:19Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "153.02",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0019",
      "title": "Pro Headlamp",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "153.02",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/187",
   "name": "#1188",
   "processedAt": "2026-11-10T00:44:12Z",
   "updatedAt": "2026-11-19T18:00:24Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "160.87",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0090",
      "title": "Ridge Dry Bag",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "160.87",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/188",
   "name": "#1189",
   "processedAt": "2026-10-04T21:15:23Z",
   "updatedAt": "2026-11-19T18:00:25Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "123.58",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0064",
      "title": "Basecamp Headlamp",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "123.58",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/189",
   "name": "#1190",
   "processedAt": "2026-11-15T12:55:27Z",
   "updatedAt": "2026-11-19T18:00:26Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "109.31",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0059",
      "title": "Summit Compass",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "109.31",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/190",
   "name": "#1191",
   "processedAt": "2026-10-22T08:49:17Z",
   "updatedAt": "2026-11-19T18:00:28Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "255.47",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0086",
      "title": "Ridge Hammock",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "151.54",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0014",
      "title": "Lite Compass",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "103.93",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/191",
   "name": "#1192",
   "processedAt": "2026-11-03T07:59:21Z",
   "updatedAt": "2026-11-19T18:00:29Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "83.93",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0092",
      "title": "Alpine Sleeping Bag",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "83.93",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/192",
   "name": "#1193",
   "processedAt": "2026-10-07T13:34:54Z",
   "updatedAt": "2026-11-19T18:01:33Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "530.05",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0148",
      "title": "Coast Gaiters",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "185.29",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/193",
   "name": "#1194",
   "processedAt": "2026-10-10T10:56:16Z",
   "updatedAt": "2026-11-19T18:01:35Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "172.38",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/194",
   "name": "#1195",
   "processedAt": "2026-10-03T13:31:52Z",
   "updatedAt": "2026-11-19T18:01:36Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "185.29",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0148",
      "title": "Coast Gaiters",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "185.29",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/195",
   "name": "#1196",
   "processedAt": "2026-11-03T22:51:53Z",
   "updatedAt": "2026-11-19T18:01:38Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "344.76",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/196",
   "name": "#1197",
   "processedAt": "2026-10-29T06:40:21Z",
   "updatedAt": "2026-11-19T18:01:39Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "108.06",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0106",
      "title": "Canyon Tent",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "54.03",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/197",
   "name": "#1198",
   "processedAt": "2026-11-02T07:34:09Z",
   "updatedAt": "2026-11-19T18:02:44Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "309.24",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0053",
      "title": "Summit Rain Jacket",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "154.62",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/198",
   "name": "#1199",
   "processedAt": "2026-10-14T18:41:55Z",
   "updatedAt": "2026-11-19T18:02:45Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "260.7",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0050",
      "title": "Summit Backpack",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "75.41",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0148",
      "title": "Coast Gaiters",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "185.29",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/199",
   "name": "#1200",
   "processedAt": "2026-09-05T14:45:22Z",
   "updatedAt": "2026-11-19T18:02:46Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "153.02",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0019",
      "title": "Pro Headlamp",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "153.02",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/200",
   "name": "#1201",
   "processedAt": "2026-10-17T09:13:54Z",
   "updatedAt": "2026-11-19T18:02:48Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "172.38",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/201",
   "name": "#1202",
   "processedAt": "2026-10-08T05:42:31Z",
   "updatedAt": "2026-11-19T18:02:49Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "172.38",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/202",
   "name": "#1203",
   "processedAt": "2026-10-22T03:26:09Z",
   "updatedAt": "2026-11-19T18:03:54Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "17.96",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0071",
      "title": "Basecamp Hammock",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "17.96",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/203",
   "name": "#1204",
   "processedAt": "2026-09-13T22:55:46Z",
   "updatedAt": "2026-11-19T18:03:55Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "344.76",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/204",
   "name": "#1205",
   "processedAt": "2026-10-25T21:27:05Z",
   "updatedAt": "2026-11-19T18:03:57Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "347.99",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0136",
      "title": "Coast Tent",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "139.67",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0037",
      "title": "Trail Trekking Poles",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "208.32",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/205",
   "name": "#1206",
   "processedAt": "2026-09-22T20:41:15Z",
   "updatedAt": "2026-11-19T18:03:58Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "262.43",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0112",
      "title": "Canyon Trekking Poles",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "130.79",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0145",
      "title": "Coast Cookset",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "65.82",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/206",
   "name": "#1207",
   "processedAt": "2026-10-26T23:51:31Z",
   "updatedAt": "2026-11-19T18:04:00Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "154.62",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0053",
      "title": "Summit Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "154.62",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/207",
   "name": "#1208",
   "processedAt": "2026-10-28T13:45:08Z",
   "updatedAt": "2026-11-19T18:05:04Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "374.1",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0052",
      "title": "Summit Trekking Poles",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "187.05",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/208",
   "name": "#1209",
   "processedAt": "2026-09-21T17:11:42Z",
   "updatedAt": "2026-11-19T18:05:05Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "185.29",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0148",
      "title": "Coast Gaiters",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "185.29",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/209",
   "name": "#1210",
   "processedAt": "2026-09-27T00:30:31Z",
   "updatedAt": "2026-11-19T18:05:07Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "90.16",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0036",
      "title": "Trail Water Filter",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "45.08",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/210",
   "name": "#1211",
   "processedAt": "2026-09-28T06:56:54Z",
   "updatedAt": "2026-11-19T18:05:08Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "31.3",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0033",
      "title": "Trail Stove",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "31.3",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/211",
   "name": "#1212",
   "processedAt": "2026-10-05T05:07:01Z",
   "updatedAt": "2026-11-19T18:05:10Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "172.38",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/212",
   "name": "#1213",
   "processedAt": "2026-09-13T15:44:45Z",
   "updatedAt": "2026-11-19T18:06:14Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "218.31",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0068",
      "title": "Basecamp Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "50.45",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0092",
      "title": "Alpine Sleeping Bag",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "83.93",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/213",
   "name": "#1214",
   "processedAt": "2026-11-03T13:18:27Z",
   "updatedAt": "2026-11-19T18:06:15Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "368.22",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0128",
      "title": "Forest Rain Jacket",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "184.11",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/214",
   "name": "#1215",
   "processedAt": "2026-11-11T02:43:05Z",
   "updatedAt": "2026-11-19T18:06:17Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "112.67",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0132",
      "title": "Forest Fleece",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "112.67",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/215",
   "name": "#1216",
   "processedAt": "2026-09-03T10:23:53Z",
   "updatedAt": "2026-11-19T18:06:19Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "43.77",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0133",
      "title": "Forest Gaiters",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "43.77",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/216",
   "name": "#1217",
   "processedAt": "2026-10-03T21:35:48Z",
   "updatedAt": "2026-11-19T18:06:21Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "185.29",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0148",
      "title": "Coast Gaiters",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "185.29",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/217",
   "name": "#1218",
   "processedAt": "2026-09-13T03:44:54Z",
   "updatedAt": "2026-11-19T18:07:25Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "293.79",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0117",
      "title": "Canyon Fleece",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "132.77",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0061",
      "title": "Basecamp Tent",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "80.51",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/218",
   "name": "#1219",
   "processedAt": "2026-10-09T06:21:36Z",
   "updatedAt": "2026-11-19T18:07:26Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "55.92",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0094",
      "title": "Alpine Headlamp",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "27.96",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/219",
   "name": "#1220",
   "processedAt": "2026-09-27T18:22:01Z",
   "updatedAt": "2026-11-19T18:07:28Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "156.75",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0085",
      "title": "Ridge Cookset",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "156.75",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/220",
   "name": "#1221",
   "processedAt": "2026-09-19T17:02:01Z",
   "updatedAt": "2026-11-19T18:07:29Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "153.02",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0019",
      "title": "Pro Headlamp",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "153.02",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/221",
   "name": "#1222",
   "processedAt": "2026-11-19T06:14:18Z",
   "updatedAt": "2026-11-19T18:07:30Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "UNFULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "301.01",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0043",
      "title": "Trail Gaiters",
      "currentQuantity": 1,
      "unfulfilledQuantity": 1,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "147.99",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0019",
      "title": "Pro Headlamp",
      "currentQuantity": 1,
      "unfulfilledQuantity": 1,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "153.02",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/222",
   "name": "#1223",
   "processedAt": "2026-09-10T20:29:45Z",
   "updatedAt": "2026-11-19T18:08:34Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "139.67",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0136",
      "title": "Coast Tent",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "139.67",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/223",
   "name": "#1224",
   "processedAt": "2026-08-25T14:35:37Z",
   "updatedAt": "2026-11-19T18:08:36Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "390.98",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0065",
      "title": "Basecamp Backpack",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "145.52",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0055",
      "title": "Summit Cookset",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "99.94",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/224",
   "name": "#1225",
   "processedAt": "2026-09-12T02:41:11Z",
   "updatedAt": "2026-11-19T18:08:37Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "50.18",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0121",
      "title": "Forest Tent",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "50.18",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/225",
   "name": "#1226",
   "processedAt": "2026-10-21T20:10:52Z",
   "updatedAt": "2026-11-19T18:08:39Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "139.67",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0136",
      "title": "Coast Tent",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "139.67",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/226",
   "name": "#1227",
   "processedAt": "2026-10-25T05:10:45Z",
   "updatedAt": "2026-11-19T18:08:40Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "109.31",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0059",
      "title": "Summit Compass",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "109.31",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/227",
   "name": "#1228",
   "processedAt": "2026-11-11T20:02:38Z",
   "updatedAt": "2026-11-19T18:09:45Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "43.77",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0133",
      "title": "Forest Gaiters",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "43.77",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/228",
   "name": "#1229",
   "processedAt": "2026-11-11T14:03:17Z",
   "updatedAt": "2026-11-19T18:09:46Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "317.63",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0037",
      "title": "Trail Trekking Poles",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "208.32",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0059",
      "title": "Summit Compass",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "109.31",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/229",
   "name": "#1230",
   "processedAt": "2026-11-18T23:49:28Z",
   "updatedAt": "2026-11-19T18:09:47Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "UNFULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "172.38",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 1,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/230",
   "name": "#1231",
   "processedAt": "2026-10-18T11:53:07Z",
   "updatedAt": "2026-11-19T18:09:48Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "497.15",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0061",
      "title": "Basecamp Tent",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "80.51",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0037",
      "title": "Trail Trekking Poles",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "208.32",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/231",
   "name": "#1232",
   "processedAt": "2026-11-06T08:22:59Z",
   "updatedAt": "2026-11-19T18:09:50Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "132.77",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0117",
      "title": "Canyon Fleece",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "132.77",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/232",
   "name": "#1233",
   "processedAt": "2026-08-25T18:49:59Z",
   "updatedAt": "2026-11-19T18:10:54Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "39.12",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0150",
      "title": "Coast Dry Bag",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "39.12",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/233",
   "name": "#1234",
   "processedAt": "2026-10-24T15:43:07Z",
   "updatedAt": "2026-11-19T18:10:56Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "154.62",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0053",
      "title": "Summit Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "154.62",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/234",
   "name": "#1235",
   "processedAt": "2026-09-07T05:16:03Z",
   "updatedAt": "2026-11-19T18:10:57Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "285.76",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0143",
      "title": "Coast Rain Jacket",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "142.88",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/235",
   "name": "#1236",
   "processedAt": "2026-09-10T22:56:07Z",
   "updatedAt": "2026-11-19T18:10:59Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "139.67",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0136",
      "title": "Coast Tent",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "139.67",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/236",
   "name": "#1237",
   "processedAt": "2026-11-12T21:27:03Z",
   "updatedAt": "2026-11-19T18:11:00Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "435.3",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0046",
      "title": "Summit Tent",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "141.08",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0009",
      "title": "Lite Camp Chair",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "190.29",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0014",
      "title": "Lite Compass",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "103.93",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/237",
   "name": "#1238",
   "processedAt": "2026-09-06T13:23:53Z",
   "updatedAt": "2026-11-19T18:12:05Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "139.67",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0136",
      "title": "Coast Tent",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "139.67",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/238",
   "name": "#1239",
   "processedAt": "2026-11-07T20:20:12Z",
   "updatedAt": "2026-11-19T18:12:06Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "417.82",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0014",
      "title": "Lite Compass",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "103.93",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0090",
      "title": "Ridge Dry Bag",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "160.87",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0019",
      "title": "Pro Headlamp",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "153.02",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/239",
   "name": "#1240",
   "processedAt": "2026-11-11T13:27:31Z",
   "updatedAt": "2026-11-19T18:12:07Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "272.17",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0058",
      "title": "Summit Gaiters",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "14.53",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0080",
      "title": "Ridge Backpack",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "85.26",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/240",
   "name": "#1241",
   "processedAt": "2026-09-08T13:24:25Z",
   "updatedAt": "2026-11-19T18:12:09Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "68.32",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0012",
      "title": "Lite Fleece",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.16",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/241",
   "name": "#1242",
   "processedAt": "2026-11-05T07:13:44Z",
   "updatedAt": "2026-11-19T18:12:10Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "97.31",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0075",
      "title": "Basecamp Dry Bag",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "97.31",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/242",
   "name": "#1243",
   "processedAt": "2026-11-06T19:54:38Z",
   "updatedAt": "2026-11-19T18:13:15Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "80.51",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0061",
      "title": "Basecamp Tent",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "80.51",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/243",
   "name": "#1244",
   "processedAt": "2026-10-17T02:14:57Z",
   "updatedAt": "2026-11-19T18:13:16Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "306.04",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0019",
      "title": "Pro Headlamp",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "153.02",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/244",
   "name": "#1245",
   "processedAt": "2026-09-14T00:48:21Z",
   "updatedAt": "2026-11-19T18:13:18Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "486.43",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0108",
      "title": "Canyon Stove",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "141.67",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/245",
   "name": "#1246",
   "processedAt": "2026-10-19T15:15:56Z",
   "updatedAt": "2026-11-19T18:13:19Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "172.38",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/246",
   "name": "#1247",
   "processedAt": "2026-10-01T13:40:26Z",
   "updatedAt": "2026-11-19T18:13:21Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "232.54",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 4,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0145",
      "title": "Coast Cookset",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "65.82",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0068",
      "title": "Basecamp Rain Jacket",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "50.45",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/247",
   "name": "#1248",
   "processedAt": "2026-10-29T23:25:36Z",
   "updatedAt": "2026-11-19T18:14:26Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "235.43",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0004",
      "title": "Lite Headlamp",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "63.05",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/248",
   "name": "#1249",
   "processedAt": "2026-10-05T06:45:08Z",
   "updatedAt": "2026-11-19T18:14:27Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "141.67",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0108",
      "title": "Canyon Stove",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "141.67",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/249",
   "name": "#1250",
   "processedAt": "2026-09-01T11:49:38Z",
   "updatedAt": "2026-11-19T18:14:29Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "109.31",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0059",
      "title": "Summit Compass",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "109.31",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/250",
   "name": "#1251",
   "processedAt": "2026-10-02T07:54:27Z",
   "updatedAt": "2026-11-19T18:14:30Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "344.76",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/251",
   "name": "#1252",
   "processedAt": "2026-10-11T13:59:33Z",
   "updatedAt": "2026-11-19T18:14:32Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "60.95",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0116",
      "title": "Canyon Hammock",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "60.95",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/252",
   "name": "#1253",
   "processedAt": "2026-09-02T08:14:12Z",
   "updatedAt": "2026-11-19T18:15:36Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "419.61",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0063",
      "title": "Basecamp Stove",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "28.22",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0021",
      "title": "Pro Water Filter",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "219.01",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/253",
   "name": "#1254",
   "processedAt": "2026-09-08T06:53:18Z",
   "updatedAt": "2026-11-19T18:15:37Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "92.24",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0127",
      "title": "Forest Trekking Poles",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "92.24",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/254",
   "name": "#1255",
   "processedAt": "2026-11-08T09:43:07Z",
   "updatedAt": "2026-11-19T18:15:39Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "109.31",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0059",
      "title": "Summit Compass",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "109.31",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/255",
   "name": "#1256",
   "processedAt": "2026-11-08T03:05:20Z",
   "updatedAt": "2026-11-19T18:15:41Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "151.54",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0086",
      "title": "Ridge Hammock",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "151.54",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/256",
   "name": "#1257",
   "processedAt": "2026-09-30T16:07:35Z",
   "updatedAt": "2026-11-19T18:15:42Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "306.04",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0019",
      "title": "Pro Headlamp",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "153.02",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/257",
   "name": "#1258",
   "processedAt": "2026-10-15T01:56:49Z",
   "updatedAt": "2026-11-19T18:16:46Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "21.82",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0113",
      "title": "Canyon Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "21.82",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/258",
   "name": "#1259",
   "processedAt": "2026-09-17T00:13:54Z",
   "updatedAt": "2026-11-19T18:16:48Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "151.83",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0041",
      "title": "Trail Hammock",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "151.83",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/259",
   "name": "#1260",
   "processedAt": "2026-09-24T16:13:08Z",
   "updatedAt": "2026-11-19T18:16:49Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "43.77",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0133",
      "title": "Forest Gaiters",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "43.77",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/260",
   "name": "#1261",
   "processedAt": "2026-09-23T01:00:37Z",
   "updatedAt": "2026-11-19T18:16:50Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "109.31",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0059",
      "title": "Summit Compass",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "109.31",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/261",
   "name": "#1262",
   "processedAt": "2026-08-23T11:06:39Z",
   "updatedAt": "2026-11-19T18:16:52Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "172.38",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/262",
   "name": "#1263",
   "processedAt": "2026-08-29T02:55:28Z",
   "updatedAt": "2026-11-19T18:17:57Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "386.61",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0066",
      "title": "Basecamp Water Filter",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "45.29",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0028",
      "title": "Pro Gaiters",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "170.66",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/263",
   "name": "#1264",
   "processedAt": "2026-09-13T01:29:24Z",
   "updatedAt": "2026-11-19T18:17:58Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "220.82",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0108",
      "title": "Canyon Stove",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "141.67",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0123",
      "title": "Forest Stove",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "79.15",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/264",
   "name": "#1265",
   "processedAt": "2026-09-05T00:21:29Z",
   "updatedAt": "2026-11-19T18:18:00Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "139.67",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0136",
      "title": "Coast Tent",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "139.67",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/265",
   "name": "#1266",
   "processedAt": "2026-11-11T04:55:13Z",
   "updatedAt": "2026-11-19T18:18:01Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "34.16",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0012",
      "title": "Lite Fleece",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.16",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/266",
   "name": "#1267",
   "processedAt": "2026-10-29T23:44:57Z",
   "updatedAt": "2026-11-19T18:18:02Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "497.78",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0019",
      "title": "Pro Headlamp",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "153.02",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/267",
   "name": "#1268",
   "processedAt": "2026-09-01T00:10:14Z",
   "updatedAt": "2026-11-19T18:19:07Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "153.02",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0019",
      "title": "Pro Headlamp",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "153.02",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/268",
   "name": "#1269",
   "processedAt": "2026-10-16T11:42:53Z",
   "updatedAt": "2026-11-19T18:19:08Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "90.16",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0036",
      "title": "Trail Water Filter",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "45.08",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/269",
   "name": "#1270",
   "processedAt": "2026-11-04T08:32:16Z",
   "updatedAt": "2026-11-19T18:19:10Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "125.46",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0141",
      "title": "Coast Water Filter",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "125.46",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/270",
   "name": "#1271",
   "processedAt": "2026-11-03T17:09:54Z",
   "updatedAt": "2026-11-19T18:19:11Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "317.64",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0006",
      "title": "Lite Water Filter",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "163.02",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0053",
      "title": "Summit Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "154.62",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/271",
   "name": "#1272",
   "processedAt": "2026-09-11T19:03:19Z",
   "updatedAt": "2026-11-19T18:19:13Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "298.53",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0091",
      "title": "Alpine Tent",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "16.84",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0059",
      "title": "Summit Compass",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "109.31",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/272",
   "name": "#1273",
   "processedAt": "2026-10-19T16:29:06Z",
   "updatedAt": "2026-11-19T18:20:17Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "95.99",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0039",
      "title": "Trail Camp Chair",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "95.99",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/273",
   "name": "#1274",
   "processedAt": "2026-10-17T05:11:23Z",
   "updatedAt": "2026-11-19T18:20:19Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "183.08",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0093",
      "title": "Alpine Stove",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "30.06",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0019",
      "title": "Pro Headlamp",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "153.02",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/274",
   "name": "#1275",
   "processedAt": "2026-09-02T08:24:49Z",
   "updatedAt": "2026-11-19T18:20:20Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "411.54",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0122",
      "title": "Forest Sleeping Bag",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "205.77",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/275",
   "name": "#1276",
   "processedAt": "2026-08-29T23:11:32Z",
   "updatedAt": "2026-11-19T18:20:22Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "45.08",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0036",
      "title": "Trail Water Filter",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "45.08",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/276",
   "name": "#1277",
   "processedAt": "2026-09-10T16:24:25Z",
   "updatedAt": "2026-11-19T18:20:23Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "426.76",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0010",
      "title": "Lite Cookset",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "144.15",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0002",
      "title": "Lite Sleeping Bag",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "205.42",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0144",
      "title": "Coast Camp Chair",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "77.19",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/277",
   "name": "#1278",
   "processedAt": "2026-11-09T12:04:31Z",
   "updatedAt": "2026-11-19T18:21:28Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "131.69",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0147",
      "title": "Coast Fleece",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "131.69",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/278",
   "name": "#1279",
   "processedAt": "2026-11-05T20:22:22Z",
   "updatedAt": "2026-11-19T18:21:29Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "349.82",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0110",
      "title": "Canyon Backpack",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "174.91",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/279",
   "name": "#1280",
   "processedAt": "2026-08-27T11:02:23Z",
   "updatedAt": "2026-11-19T18:21:31Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "132.77",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0117",
      "title": "Canyon Fleece",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "132.77",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/280",
   "name": "#1281",
   "processedAt": "2026-08-26T09:33:05Z",
   "updatedAt": "2026-11-19T18:21:32Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "208.88",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0147",
      "title": "Coast Fleece",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "131.69",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0144",
      "title": "Coast Camp Chair",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "77.19",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/281",
   "name": "#1282",
   "processedAt": "2026-09-14T19:55:21Z",
   "updatedAt": "2026-11-19T18:21:34Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "410.76",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 3,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0047",
      "title": "Summit Sleeping Bag",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "66.0",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/282",
   "name": "#1283",
   "processedAt": "2026-09-05T03:44:42Z",
   "updatedAt": "2026-11-19T18:22:38Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "172.38",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/283",
   "name": "#1284",
   "processedAt": "2026-09-10T09:51:13Z",
   "updatedAt": "2026-11-19T18:22:40Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "338.68",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0104",
      "title": "Alpine Compass",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "169.34",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/284",
   "name": "#1285",
   "processedAt": "2026-10-11T21:39:46Z",
   "updatedAt": "2026-11-19T18:22:41Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "79.47",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0008",
      "title": "Lite Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "79.47",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/285",
   "name": "#1286",
   "processedAt": "2026-10-18T11:59:15Z",
   "updatedAt": "2026-11-19T18:22:42Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "172.38",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/286",
   "name": "#1287",
   "processedAt": "2026-09-19T04:08:49Z",
   "updatedAt": "2026-11-19T18:22:44Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "218.57",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0017",
      "title": "Pro Sleeping Bag",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "34.46",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0128",
      "title": "Forest Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "184.11",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/287",
   "name": "#1288",
   "processedAt": "2026-11-07T08:16:50Z",
   "updatedAt": "2026-11-19T18:23:48Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "156.75",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0085",
      "title": "Ridge Cookset",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "156.75",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/288",
   "name": "#1289",
   "processedAt": "2026-11-14T11:20:57Z",
   "updatedAt": "2026-11-19T18:23:50Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "172.38",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0023",
      "title": "Pro Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "172.38",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/289",
   "name": "#1290",
   "processedAt": "2026-10-21T01:52:32Z",
   "updatedAt": "2026-11-19T18:23:51Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "131.13",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0059",
      "title": "Summit Compass",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "109.31",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0113",
      "title": "Canyon Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "21.82",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/290",
   "name": "#1291",
   "processedAt": "2026-10-15T06:45:40Z",
   "updatedAt": "2026-11-19T18:23:53Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "587.08",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 4,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0100",
      "title": "Alpine Cookset",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "212.12",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0144",
      "title": "Coast Camp Chair",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "77.19",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0114",
      "title": "Canyon Camp Chair",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "85.65",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/291",
   "name": "#1292",
   "processedAt": "2026-09-20T10:11:45Z",
   "updatedAt": "2026-11-19T18:23:54Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "575.16",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 4,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0132",
      "title": "Forest Fleece",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "112.67",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0110",
      "title": "Canyon Backpack",
      "currentQuantity": 2,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "174.91",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/292",
   "name": "#1293",
   "processedAt": "2026-10-19T16:45:12Z",
   "updatedAt": "2026-11-19T18:24:59Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "219.02",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 2,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0047",
      "title": "Summit Sleeping Bag",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "66.0",
        "currencyCode": "USD"
       }
      }
     },
     {
      "sku": "P4-0019",
      "title": "Pro Headlamp",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "153.02",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/293",
   "name": "#1294",
   "processedAt": "2026-10-17T18:49:59Z",
   "updatedAt": "2026-11-19T18:25:00Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "160.87",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0090",
      "title": "Ridge Dry Bag",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "160.87",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/294",
   "name": "#1295",
   "processedAt": "2026-08-27T15:56:24Z",
   "updatedAt": "2026-11-19T18:25:02Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "208.32",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0037",
      "title": "Trail Trekking Poles",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "208.32",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/295",
   "name": "#1296",
   "processedAt": "2026-09-11T08:54:03Z",
   "updatedAt": "2026-11-19T18:25:03Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "112.67",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0132",
      "title": "Forest Fleece",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "112.67",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/296",
   "name": "#1297",
   "processedAt": "2026-11-05T01:10:36Z",
   "updatedAt": "2026-11-19T18:25:05Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "130.79",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0112",
      "title": "Canyon Trekking Poles",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "130.79",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/297",
   "name": "#1298",
   "processedAt": "2026-11-17T12:21:30Z",
   "updatedAt": "2026-11-19T18:26:09Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "207.17",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0098",
      "title": "Alpine Rain Jacket",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "207.17",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/298",
   "name": "#1299",
   "processedAt": "2026-10-26T18:44:41Z",
   "updatedAt": "2026-11-19T18:26:10Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "77.19",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0144",
      "title": "Coast Camp Chair",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "77.19",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/299",
   "name": "#1300",
   "processedAt": "2026-09-30T22:16:34Z",
   "updatedAt": "2026-11-19T18:26:12Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "80.51",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0061",
      "title": "Basecamp Tent",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "80.51",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  },
  {
   "id": "gid://shopify/Order/300",
   "name": "#1301",
   "processedAt": "2026-11-15T18:37:05Z",
   "updatedAt": "2026-11-19T18:26:13Z",
   "cancelledAt": null,
   "displayFinancialStatus": "PAID",
   "displayFulfillmentStatus": "FULFILLED",
   "returnStatus": "NO_RETURN",
   "currentTotalPriceSet": {
    "shopMoney": {
     "amount": "138.0",
     "currencyCode": "USD"
    }
   },
   "totalRefundedSet": {
    "shopMoney": {
     "amount": "0.0",
     "currencyCode": "USD"
    }
   },
   "currentSubtotalLineItemsQuantity": 1,
   "lineItems": {
    "nodes": [
     {
      "sku": "P4-0103",
      "title": "Alpine Gaiters",
      "currentQuantity": 1,
      "unfulfilledQuantity": 0,
      "originalUnitPriceSet": {
       "shopMoney": {
        "amount": "138.0",
        "currencyCode": "USD"
       }
      }
     }
    ]
   },
   "refunds": [],
   "returns": {
    "nodes": []
   }
  }
 ],
 "products": [
  {
   "id": "gid://shopify/Product/1",
   "title": "Lite Tent",
   "status": "ACTIVE",
   "totalInventory": 70,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/1",
      "sku": "P4-0001",
      "title": "Default Title",
      "price": "123.90",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 70
           },
           {
            "name": "on_hand",
            "quantity": 70
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/2",
   "title": "Lite Sleeping Bag",
   "status": "ACTIVE",
   "totalInventory": 111,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/2",
      "sku": "P4-0002",
      "title": "Default Title",
      "price": "205.42",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 111
           },
           {
            "name": "on_hand",
            "quantity": 111
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/3",
   "title": "Lite Stove",
   "status": "ACTIVE",
   "totalInventory": 71,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/3",
      "sku": "P4-0003",
      "title": "Default Title",
      "price": "149.78",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 71
           },
           {
            "name": "on_hand",
            "quantity": 71
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/4",
   "title": "Lite Headlamp",
   "status": "ACTIVE",
   "totalInventory": 92,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/4",
      "sku": "P4-0004",
      "title": "Default Title",
      "price": "63.05",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 92
           },
           {
            "name": "on_hand",
            "quantity": 92
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/5",
   "title": "Lite Backpack",
   "status": "ACTIVE",
   "totalInventory": 125,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/5",
      "sku": "P4-0005",
      "title": "Default Title",
      "price": "80.96",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 125
           },
           {
            "name": "on_hand",
            "quantity": 125
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/6",
   "title": "Lite Water Filter",
   "status": "ACTIVE",
   "totalInventory": 155,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/6",
      "sku": "P4-0006",
      "title": "Default Title",
      "price": "163.02",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 155
           },
           {
            "name": "on_hand",
            "quantity": 155
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/7",
   "title": "Lite Trekking Poles",
   "status": "ACTIVE",
   "totalInventory": 198,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/7",
      "sku": "P4-0007",
      "title": "Default Title",
      "price": "136.81",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 198
           },
           {
            "name": "on_hand",
            "quantity": 198
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/8",
   "title": "Lite Rain Jacket",
   "status": "ACTIVE",
   "totalInventory": 155,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/8",
      "sku": "P4-0008",
      "title": "Default Title",
      "price": "79.47",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 155
           },
           {
            "name": "on_hand",
            "quantity": 155
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/9",
   "title": "Lite Camp Chair",
   "status": "ACTIVE",
   "totalInventory": 56,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/9",
      "sku": "P4-0009",
      "title": "Default Title",
      "price": "190.29",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 56
           },
           {
            "name": "on_hand",
            "quantity": 56
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/10",
   "title": "Lite Cookset",
   "status": "ACTIVE",
   "totalInventory": 39,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/10",
      "sku": "P4-0010",
      "title": "Default Title",
      "price": "144.15",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 39
           },
           {
            "name": "on_hand",
            "quantity": 39
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/11",
   "title": "Lite Hammock",
   "status": "ACTIVE",
   "totalInventory": 60,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/11",
      "sku": "P4-0011",
      "title": "Default Title",
      "price": "47.66",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 60
           },
           {
            "name": "on_hand",
            "quantity": 60
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/12",
   "title": "Lite Fleece",
   "status": "ACTIVE",
   "totalInventory": 57,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/12",
      "sku": "P4-0012",
      "title": "Default Title",
      "price": "34.16",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 57
           },
           {
            "name": "on_hand",
            "quantity": 57
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/13",
   "title": "Lite Gaiters",
   "status": "ACTIVE",
   "totalInventory": 29,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/13",
      "sku": "P4-0013",
      "title": "Default Title",
      "price": "34.53",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 29
           },
           {
            "name": "on_hand",
            "quantity": 29
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/14",
   "title": "Lite Compass",
   "status": "ACTIVE",
   "totalInventory": 97,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/14",
      "sku": "P4-0014",
      "title": "Default Title",
      "price": "103.93",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 97
           },
           {
            "name": "on_hand",
            "quantity": 97
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/15",
   "title": "Lite Dry Bag",
   "status": "ACTIVE",
   "totalInventory": 108,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/15",
      "sku": "P4-0015",
      "title": "Default Title",
      "price": "127.96",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 108
           },
           {
            "name": "on_hand",
            "quantity": 108
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/16",
   "title": "Pro Tent",
   "status": "ACTIVE",
   "totalInventory": 85,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/16",
      "sku": "P4-0016",
      "title": "Default Title",
      "price": "203.78",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 85
           },
           {
            "name": "on_hand",
            "quantity": 85
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/17",
   "title": "Pro Sleeping Bag",
   "status": "ACTIVE",
   "totalInventory": 173,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/17",
      "sku": "P4-0017",
      "title": "Default Title",
      "price": "34.46",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 173
           },
           {
            "name": "on_hand",
            "quantity": 173
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/18",
   "title": "Pro Stove",
   "status": "ACTIVE",
   "totalInventory": 138,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/18",
      "sku": "P4-0018",
      "title": "Default Title",
      "price": "24.99",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 138
           },
           {
            "name": "on_hand",
            "quantity": 138
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/19",
   "title": "Pro Headlamp",
   "status": "ACTIVE",
   "totalInventory": 76,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/19",
      "sku": "P4-0019",
      "title": "Default Title",
      "price": "153.02",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 76
           },
           {
            "name": "on_hand",
            "quantity": 76
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/20",
   "title": "Pro Backpack",
   "status": "ACTIVE",
   "totalInventory": 24,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/20",
      "sku": "P4-0020",
      "title": "Default Title",
      "price": "188.07",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 24
           },
           {
            "name": "on_hand",
            "quantity": 24
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/21",
   "title": "Pro Water Filter",
   "status": "ACTIVE",
   "totalInventory": 38,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/21",
      "sku": "P4-0021",
      "title": "Default Title",
      "price": "219.01",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 38
           },
           {
            "name": "on_hand",
            "quantity": 38
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/22",
   "title": "Pro Trekking Poles",
   "status": "ACTIVE",
   "totalInventory": 128,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/22",
      "sku": "P4-0022",
      "title": "Default Title",
      "price": "111.59",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 128
           },
           {
            "name": "on_hand",
            "quantity": 128
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/23",
   "title": "Pro Rain Jacket",
   "status": "ACTIVE",
   "totalInventory": 105,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/23",
      "sku": "P4-0023",
      "title": "Default Title",
      "price": "172.38",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 105
           },
           {
            "name": "on_hand",
            "quantity": 105
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/24",
   "title": "Pro Camp Chair",
   "status": "ACTIVE",
   "totalInventory": 130,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/24",
      "sku": "P4-0024",
      "title": "Default Title",
      "price": "159.75",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 130
           },
           {
            "name": "on_hand",
            "quantity": 130
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/25",
   "title": "Pro Cookset",
   "status": "ACTIVE",
   "totalInventory": 60,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/25",
      "sku": "P4-0025",
      "title": "Default Title",
      "price": "208.45",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 60
           },
           {
            "name": "on_hand",
            "quantity": 60
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/26",
   "title": "Pro Hammock",
   "status": "ACTIVE",
   "totalInventory": 198,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/26",
      "sku": "P4-0026",
      "title": "Default Title",
      "price": "204.08",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 198
           },
           {
            "name": "on_hand",
            "quantity": 198
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/27",
   "title": "Pro Fleece",
   "status": "ACTIVE",
   "totalInventory": 85,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/27",
      "sku": "P4-0027",
      "title": "Default Title",
      "price": "26.68",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 85
           },
           {
            "name": "on_hand",
            "quantity": 85
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/28",
   "title": "Pro Gaiters",
   "status": "ACTIVE",
   "totalInventory": 53,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/28",
      "sku": "P4-0028",
      "title": "Default Title",
      "price": "170.66",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 53
           },
           {
            "name": "on_hand",
            "quantity": 53
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/29",
   "title": "Pro Compass",
   "status": "ACTIVE",
   "totalInventory": 143,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/29",
      "sku": "P4-0029",
      "title": "Default Title",
      "price": "205.81",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 143
           },
           {
            "name": "on_hand",
            "quantity": 143
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/30",
   "title": "Pro Dry Bag",
   "status": "ACTIVE",
   "totalInventory": 56,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/30",
      "sku": "P4-0030",
      "title": "Default Title",
      "price": "143.33",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 56
           },
           {
            "name": "on_hand",
            "quantity": 56
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/31",
   "title": "Trail Tent",
   "status": "ACTIVE",
   "totalInventory": 175,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/31",
      "sku": "P4-0031",
      "title": "Default Title",
      "price": "178.05",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 175
           },
           {
            "name": "on_hand",
            "quantity": 175
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/32",
   "title": "Trail Sleeping Bag",
   "status": "ACTIVE",
   "totalInventory": 147,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/32",
      "sku": "P4-0032",
      "title": "Default Title",
      "price": "167.81",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 147
           },
           {
            "name": "on_hand",
            "quantity": 147
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/33",
   "title": "Trail Stove",
   "status": "ACTIVE",
   "totalInventory": 159,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/33",
      "sku": "P4-0033",
      "title": "Default Title",
      "price": "31.30",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 159
           },
           {
            "name": "on_hand",
            "quantity": 159
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/34",
   "title": "Trail Headlamp",
   "status": "ACTIVE",
   "totalInventory": 95,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/34",
      "sku": "P4-0034",
      "title": "Default Title",
      "price": "186.41",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 95
           },
           {
            "name": "on_hand",
            "quantity": 95
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/35",
   "title": "Trail Backpack",
   "status": "ACTIVE",
   "totalInventory": 197,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/35",
      "sku": "P4-0035",
      "title": "Default Title",
      "price": "190.69",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 197
           },
           {
            "name": "on_hand",
            "quantity": 197
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/36",
   "title": "Trail Water Filter",
   "status": "ACTIVE",
   "totalInventory": 161,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/36",
      "sku": "P4-0036",
      "title": "Default Title",
      "price": "45.08",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 161
           },
           {
            "name": "on_hand",
            "quantity": 161
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/37",
   "title": "Trail Trekking Poles",
   "status": "ACTIVE",
   "totalInventory": 143,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/37",
      "sku": "P4-0037",
      "title": "Default Title",
      "price": "208.32",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 143
           },
           {
            "name": "on_hand",
            "quantity": 143
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/38",
   "title": "Trail Rain Jacket",
   "status": "ACTIVE",
   "totalInventory": -4,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/38",
      "sku": "P4-0038",
      "title": "Default Title",
      "price": "168.45",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": -4
           },
           {
            "name": "on_hand",
            "quantity": -4
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/39",
   "title": "Trail Camp Chair",
   "status": "ACTIVE",
   "totalInventory": 166,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/39",
      "sku": "P4-0039",
      "title": "Default Title",
      "price": "95.99",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 166
           },
           {
            "name": "on_hand",
            "quantity": 166
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/40",
   "title": "Trail Cookset",
   "status": "ACTIVE",
   "totalInventory": 80,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/40",
      "sku": "P4-0040",
      "title": "Default Title",
      "price": "13.40",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 80
           },
           {
            "name": "on_hand",
            "quantity": 80
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/41",
   "title": "Trail Hammock",
   "status": "ACTIVE",
   "totalInventory": 155,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/41",
      "sku": "P4-0041",
      "title": "Default Title",
      "price": "151.83",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 155
           },
           {
            "name": "on_hand",
            "quantity": 155
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/42",
   "title": "Trail Fleece",
   "status": "ACTIVE",
   "totalInventory": 95,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/42",
      "sku": "P4-0042",
      "title": "Default Title",
      "price": "43.88",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 95
           },
           {
            "name": "on_hand",
            "quantity": 95
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/43",
   "title": "Trail Gaiters",
   "status": "ACTIVE",
   "totalInventory": 95,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/43",
      "sku": "P4-0043",
      "title": "Default Title",
      "price": "147.99",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 95
           },
           {
            "name": "on_hand",
            "quantity": 95
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/44",
   "title": "Trail Compass",
   "status": "ACTIVE",
   "totalInventory": 145,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/44",
      "sku": "P4-0044",
      "title": "Default Title",
      "price": "42.88",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 145
           },
           {
            "name": "on_hand",
            "quantity": 145
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/45",
   "title": "Trail Dry Bag",
   "status": "ACTIVE",
   "totalInventory": 28,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/45",
      "sku": "P4-0045",
      "title": "Default Title",
      "price": "128.78",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 28
           },
           {
            "name": "on_hand",
            "quantity": 28
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/46",
   "title": "Summit Tent",
   "status": "ACTIVE",
   "totalInventory": 199,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/46",
      "sku": "P4-0046",
      "title": "Default Title",
      "price": "141.08",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 199
           },
           {
            "name": "on_hand",
            "quantity": 199
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/47",
   "title": "Summit Sleeping Bag",
   "status": "ACTIVE",
   "totalInventory": 118,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/47",
      "sku": "P4-0047",
      "title": "Default Title",
      "price": "66.00",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 118
           },
           {
            "name": "on_hand",
            "quantity": 118
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/48",
   "title": "Summit Stove",
   "status": "ACTIVE",
   "totalInventory": 134,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/48",
      "sku": "P4-0048",
      "title": "Default Title",
      "price": "196.31",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 134
           },
           {
            "name": "on_hand",
            "quantity": 134
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/49",
   "title": "Summit Headlamp",
   "status": "ACTIVE",
   "totalInventory": 134,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/49",
      "sku": "P4-0049",
      "title": "Default Title",
      "price": "10.75",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 134
           },
           {
            "name": "on_hand",
            "quantity": 134
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/50",
   "title": "Summit Backpack",
   "status": "ACTIVE",
   "totalInventory": 154,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/50",
      "sku": "P4-0050",
      "title": "Default Title",
      "price": "75.41",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 154
           },
           {
            "name": "on_hand",
            "quantity": 154
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/51",
   "title": "Summit Water Filter",
   "status": "ACTIVE",
   "totalInventory": 146,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/51",
      "sku": "P4-0051",
      "title": "Default Title",
      "price": "9.92",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 146
           },
           {
            "name": "on_hand",
            "quantity": 146
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/52",
   "title": "Summit Trekking Poles",
   "status": "ACTIVE",
   "totalInventory": 175,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/52",
      "sku": "P4-0052",
      "title": "Default Title",
      "price": "187.05",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 175
           },
           {
            "name": "on_hand",
            "quantity": 175
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/53",
   "title": "Summit Rain Jacket",
   "status": "ACTIVE",
   "totalInventory": 115,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/53",
      "sku": "P4-0053",
      "title": "Default Title",
      "price": "154.62",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 115
           },
           {
            "name": "on_hand",
            "quantity": 115
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/54",
   "title": "Summit Camp Chair",
   "status": "ACTIVE",
   "totalInventory": 173,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/54",
      "sku": "P4-0054",
      "title": "Default Title",
      "price": "16.42",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 173
           },
           {
            "name": "on_hand",
            "quantity": 173
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/55",
   "title": "Summit Cookset",
   "status": "ACTIVE",
   "totalInventory": 157,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/55",
      "sku": "P4-0055",
      "title": "Default Title",
      "price": "99.94",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 157
           },
           {
            "name": "on_hand",
            "quantity": 157
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/56",
   "title": "Summit Hammock",
   "status": "ACTIVE",
   "totalInventory": 176,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/56",
      "sku": "P4-0056",
      "title": "Default Title",
      "price": "184.39",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 176
           },
           {
            "name": "on_hand",
            "quantity": 176
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/57",
   "title": "Summit Fleece",
   "status": "ACTIVE",
   "totalInventory": 62,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/57",
      "sku": "P4-0057",
      "title": "Default Title",
      "price": "211.03",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 62
           },
           {
            "name": "on_hand",
            "quantity": 62
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/58",
   "title": "Summit Gaiters",
   "status": "ACTIVE",
   "totalInventory": 108,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/58",
      "sku": "P4-0058",
      "title": "Default Title",
      "price": "14.53",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 108
           },
           {
            "name": "on_hand",
            "quantity": 108
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/59",
   "title": "Summit Compass",
   "status": "ACTIVE",
   "totalInventory": 176,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/59",
      "sku": "P4-0059",
      "title": "Default Title",
      "price": "109.31",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 176
           },
           {
            "name": "on_hand",
            "quantity": 176
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/60",
   "title": "Summit Dry Bag",
   "status": "ACTIVE",
   "totalInventory": 95,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/60",
      "sku": "P4-0060",
      "title": "Default Title",
      "price": "164.85",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 95
           },
           {
            "name": "on_hand",
            "quantity": 95
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/61",
   "title": "Basecamp Tent",
   "status": "ACTIVE",
   "totalInventory": 51,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/61",
      "sku": "P4-0061",
      "title": "Default Title",
      "price": "80.51",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 51
           },
           {
            "name": "on_hand",
            "quantity": 51
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/62",
   "title": "Summit Camp Stove",
   "status": "ACTIVE",
   "totalInventory": 193,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/62",
      "sku": "P4-0062",
      "title": "Default Title",
      "price": "168.46",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 193
           },
           {
            "name": "on_hand",
            "quantity": 193
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/63",
   "title": "Basecamp Stove",
   "status": "ACTIVE",
   "totalInventory": 89,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/63",
      "sku": "P4-0063",
      "title": "Default Title",
      "price": "28.22",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 89
           },
           {
            "name": "on_hand",
            "quantity": 89
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/64",
   "title": "Basecamp Headlamp",
   "status": "ACTIVE",
   "totalInventory": 111,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/64",
      "sku": "P4-0064",
      "title": "Default Title",
      "price": "123.58",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 111
           },
           {
            "name": "on_hand",
            "quantity": 111
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/65",
   "title": "Basecamp Backpack",
   "status": "ACTIVE",
   "totalInventory": 39,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/65",
      "sku": "P4-0065",
      "title": "Default Title",
      "price": "145.52",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 39
           },
           {
            "name": "on_hand",
            "quantity": 39
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/66",
   "title": "Basecamp Water Filter",
   "status": "ACTIVE",
   "totalInventory": 48,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/66",
      "sku": "P4-0066",
      "title": "Default Title",
      "price": "45.29",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 48
           },
           {
            "name": "on_hand",
            "quantity": 48
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/67",
   "title": "Basecamp Trekking Poles",
   "status": "ACTIVE",
   "totalInventory": 42,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/67",
      "sku": "P4-0067",
      "title": "Default Title",
      "price": "195.52",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 42
           },
           {
            "name": "on_hand",
            "quantity": 42
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/68",
   "title": "Basecamp Rain Jacket",
   "status": "ACTIVE",
   "totalInventory": 30,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/68",
      "sku": "P4-0068",
      "title": "Default Title",
      "price": "50.45",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 30
           },
           {
            "name": "on_hand",
            "quantity": 30
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/69",
   "title": "Basecamp Camp Chair",
   "status": "ACTIVE",
   "totalInventory": 30,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/69",
      "sku": "P4-0069",
      "title": "Default Title",
      "price": "120.89",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 30
           },
           {
            "name": "on_hand",
            "quantity": 30
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/70",
   "title": "Basecamp Cookset",
   "status": "ACTIVE",
   "totalInventory": 157,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/70",
      "sku": "P4-0070",
      "title": "Default Title",
      "price": "23.75",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 157
           },
           {
            "name": "on_hand",
            "quantity": 157
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/71",
   "title": "Basecamp Hammock",
   "status": "ACTIVE",
   "totalInventory": 182,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/71",
      "sku": "P4-0071",
      "title": "Default Title",
      "price": "17.96",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 182
           },
           {
            "name": "on_hand",
            "quantity": 182
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/72",
   "title": "Basecamp Fleece",
   "status": "ACTIVE",
   "totalInventory": 46,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/72",
      "sku": "P4-0072",
      "title": "Default Title",
      "price": "85.22",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 46
           },
           {
            "name": "on_hand",
            "quantity": 46
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/73",
   "title": "Basecamp Gaiters",
   "status": "ACTIVE",
   "totalInventory": 63,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/73",
      "sku": "P4-0073",
      "title": "Default Title",
      "price": "102.91",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 63
           },
           {
            "name": "on_hand",
            "quantity": 63
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/74",
   "title": "Basecamp Compass",
   "status": "ACTIVE",
   "totalInventory": 56,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/74",
      "sku": "P4-0074",
      "title": "Default Title",
      "price": "61.51",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 56
           },
           {
            "name": "on_hand",
            "quantity": 56
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/75",
   "title": "Basecamp Dry Bag",
   "status": "ACTIVE",
   "totalInventory": 129,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/75",
      "sku": "P4-0075",
      "title": "Default Title",
      "price": "97.31",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 129
           },
           {
            "name": "on_hand",
            "quantity": 129
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/76",
   "title": "Ridge Tent",
   "status": "ACTIVE",
   "totalInventory": 41,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/76",
      "sku": "P4-0076",
      "title": "Default Title",
      "price": "53.09",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 41
           },
           {
            "name": "on_hand",
            "quantity": 41
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/77",
   "title": "Ridge Sleeping Bag",
   "status": "ACTIVE",
   "totalInventory": 165,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/77",
      "sku": "P4-0077",
      "title": "Default Title",
      "price": "20.56",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 165
           },
           {
            "name": "on_hand",
            "quantity": 165
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/78",
   "title": "Ridge Stove",
   "status": "ACTIVE",
   "totalInventory": 101,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/78",
      "sku": "P4-0078",
      "title": "Default Title",
      "price": "109.82",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 101
           },
           {
            "name": "on_hand",
            "quantity": 101
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/79",
   "title": "Ridge Headlamp",
   "status": "ACTIVE",
   "totalInventory": 142,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/79",
      "sku": "P4-0079",
      "title": "Default Title",
      "price": "124.85",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 142
           },
           {
            "name": "on_hand",
            "quantity": 142
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/80",
   "title": "Ridge Backpack",
   "status": "ACTIVE",
   "totalInventory": 38,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/80",
      "sku": "P4-0080",
      "title": "Default Title",
      "price": "85.26",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 38
           },
           {
            "name": "on_hand",
            "quantity": 38
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/81",
   "title": "Ridge Water Filter",
   "status": "ACTIVE",
   "totalInventory": 68,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/81",
      "sku": "P4-0081",
      "title": "Default Title",
      "price": "110.91",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 68
           },
           {
            "name": "on_hand",
            "quantity": 68
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/82",
   "title": "Ridge Trekking Poles",
   "status": "ACTIVE",
   "totalInventory": 29,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/82",
      "sku": "P4-0082",
      "title": "Default Title",
      "price": "123.20",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 29
           },
           {
            "name": "on_hand",
            "quantity": 29
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/83",
   "title": "Ridge Rain Jacket",
   "status": "ACTIVE",
   "totalInventory": 149,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/83",
      "sku": "P4-0083",
      "title": "Default Title",
      "price": "212.64",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 149
           },
           {
            "name": "on_hand",
            "quantity": 149
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/84",
   "title": "Ridge Camp Chair",
   "status": "ACTIVE",
   "totalInventory": 146,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/84",
      "sku": "P4-0084",
      "title": "Default Title",
      "price": "33.22",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 146
           },
           {
            "name": "on_hand",
            "quantity": 146
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/85",
   "title": "Ridge Cookset",
   "status": "ACTIVE",
   "totalInventory": 59,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/85",
      "sku": "P4-0085",
      "title": "Default Title",
      "price": "156.75",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 59
           },
           {
            "name": "on_hand",
            "quantity": 59
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/86",
   "title": "Ridge Hammock",
   "status": "ACTIVE",
   "totalInventory": 68,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/86",
      "sku": "P4-0086",
      "title": "Default Title",
      "price": "151.54",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 68
           },
           {
            "name": "on_hand",
            "quantity": 68
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/87",
   "title": "Ridge Fleece",
   "status": "ACTIVE",
   "totalInventory": 117,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/87",
      "sku": "P4-0087",
      "title": "Default Title",
      "price": "45.54",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 117
           },
           {
            "name": "on_hand",
            "quantity": 117
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/88",
   "title": "Ridge Gaiters",
   "status": "ACTIVE",
   "totalInventory": 140,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/88",
      "sku": "P4-0088",
      "title": "Default Title",
      "price": "43.43",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 140
           },
           {
            "name": "on_hand",
            "quantity": 140
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/89",
   "title": "Ridge Compass",
   "status": "ACTIVE",
   "totalInventory": 22,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/89",
      "sku": "P4-0089",
      "title": "Default Title",
      "price": "216.24",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 22
           },
           {
            "name": "on_hand",
            "quantity": 22
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/90",
   "title": "Ridge Dry Bag",
   "status": "ACTIVE",
   "totalInventory": 53,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/90",
      "sku": "P4-0090",
      "title": "Default Title",
      "price": "160.87",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 53
           },
           {
            "name": "on_hand",
            "quantity": 53
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/91",
   "title": "Alpine Tent",
   "status": "ACTIVE",
   "totalInventory": 89,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/91",
      "sku": "P4-0091",
      "title": "Default Title",
      "price": "16.84",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 89
           },
           {
            "name": "on_hand",
            "quantity": 89
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/92",
   "title": "Alpine Sleeping Bag",
   "status": "ACTIVE",
   "totalInventory": 163,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/92",
      "sku": "P4-0092",
      "title": "Default Title",
      "price": "83.93",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 163
           },
           {
            "name": "on_hand",
            "quantity": 163
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/93",
   "title": "Alpine Stove",
   "status": "ACTIVE",
   "totalInventory": 184,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/93",
      "sku": "P4-0093",
      "title": "Default Title",
      "price": "30.06",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 184
           },
           {
            "name": "on_hand",
            "quantity": 184
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/94",
   "title": "Alpine Headlamp",
   "status": "ACTIVE",
   "totalInventory": 47,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/94",
      "sku": "P4-0094",
      "title": "Default Title",
      "price": "27.96",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 47
           },
           {
            "name": "on_hand",
            "quantity": 47
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/95",
   "title": "Alpine Backpack",
   "status": "ACTIVE",
   "totalInventory": 173,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/95",
      "sku": "P4-0095",
      "title": "Default Title",
      "price": "94.52",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 173
           },
           {
            "name": "on_hand",
            "quantity": 173
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/96",
   "title": "Alpine Water Filter",
   "status": "ACTIVE",
   "totalInventory": 87,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/96",
      "sku": "P4-0096",
      "title": "Default Title",
      "price": "209.49",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 87
           },
           {
            "name": "on_hand",
            "quantity": 87
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/97",
   "title": "Alpine Trekking Poles",
   "status": "ACTIVE",
   "totalInventory": 67,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/97",
      "sku": "P4-0097",
      "title": "Default Title",
      "price": "103.66",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 67
           },
           {
            "name": "on_hand",
            "quantity": 67
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/98",
   "title": "Alpine Rain Jacket",
   "status": "ACTIVE",
   "totalInventory": 75,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/98",
      "sku": "P4-0098",
      "title": "Default Title",
      "price": "207.17",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 75
           },
           {
            "name": "on_hand",
            "quantity": 75
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/99",
   "title": "Alpine Camp Chair",
   "status": "ACTIVE",
   "totalInventory": 142,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/99",
      "sku": "P4-0099",
      "title": "Default Title",
      "price": "191.05",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 142
           },
           {
            "name": "on_hand",
            "quantity": 142
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/100",
   "title": "Alpine Cookset",
   "status": "ACTIVE",
   "totalInventory": 122,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/100",
      "sku": "P4-0100",
      "title": "Default Title",
      "price": "212.12",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 122
           },
           {
            "name": "on_hand",
            "quantity": 122
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/101",
   "title": "Alpine Hammock",
   "status": "ACTIVE",
   "totalInventory": 79,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/101",
      "sku": "P4-0101",
      "title": "Default Title",
      "price": "172.79",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 79
           },
           {
            "name": "on_hand",
            "quantity": 79
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/102",
   "title": "Alpine Fleece",
   "status": "ACTIVE",
   "totalInventory": 136,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/102",
      "sku": "P4-0102",
      "title": "Default Title",
      "price": "130.56",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 136
           },
           {
            "name": "on_hand",
            "quantity": 136
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/103",
   "title": "Alpine Gaiters",
   "status": "ACTIVE",
   "totalInventory": 29,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/103",
      "sku": "P4-0103",
      "title": "Default Title",
      "price": "138.00",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 29
           },
           {
            "name": "on_hand",
            "quantity": 29
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/104",
   "title": "Alpine Compass",
   "status": "ACTIVE",
   "totalInventory": 131,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/104",
      "sku": "P4-0104",
      "title": "Default Title",
      "price": "169.34",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 131
           },
           {
            "name": "on_hand",
            "quantity": 131
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/105",
   "title": "Alpine Dry Bag",
   "status": "ACTIVE",
   "totalInventory": 61,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/105",
      "sku": "P4-0105",
      "title": "Default Title",
      "price": "115.61",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 61
           },
           {
            "name": "on_hand",
            "quantity": 61
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/106",
   "title": "Canyon Tent",
   "status": "ACTIVE",
   "totalInventory": 118,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/106",
      "sku": "P4-0106",
      "title": "Default Title",
      "price": "54.03",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 118
           },
           {
            "name": "on_hand",
            "quantity": 118
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/107",
   "title": "Canyon Sleeping Bag",
   "status": "ACTIVE",
   "totalInventory": 157,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/107",
      "sku": "P4-0107",
      "title": "Default Title",
      "price": "178.20",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 157
           },
           {
            "name": "on_hand",
            "quantity": 157
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/108",
   "title": "Canyon Stove",
   "status": "ACTIVE",
   "totalInventory": 165,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/108",
      "sku": "P4-0108",
      "title": "Default Title",
      "price": "141.67",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 165
           },
           {
            "name": "on_hand",
            "quantity": 165
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/109",
   "title": "Canyon Headlamp",
   "status": "ACTIVE",
   "totalInventory": 60,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/109",
      "sku": "P4-0109",
      "title": "Default Title",
      "price": "114.64",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 60
           },
           {
            "name": "on_hand",
            "quantity": 60
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/110",
   "title": "Canyon Backpack",
   "status": "ACTIVE",
   "totalInventory": 143,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/110",
      "sku": "P4-0110",
      "title": "Default Title",
      "price": "174.91",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 143
           },
           {
            "name": "on_hand",
            "quantity": 143
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/111",
   "title": "Canyon Water Filter",
   "status": "ACTIVE",
   "totalInventory": 57,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/111",
      "sku": "P4-0111",
      "title": "Default Title",
      "price": "75.56",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 57
           },
           {
            "name": "on_hand",
            "quantity": 57
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/112",
   "title": "Canyon Trekking Poles",
   "status": "ACTIVE",
   "totalInventory": 41,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/112",
      "sku": "P4-0112",
      "title": "Default Title",
      "price": "130.79",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 41
           },
           {
            "name": "on_hand",
            "quantity": 41
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/113",
   "title": "Canyon Rain Jacket",
   "status": "ACTIVE",
   "totalInventory": 72,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/113",
      "sku": "P4-0113",
      "title": "Default Title",
      "price": "21.82",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 72
           },
           {
            "name": "on_hand",
            "quantity": 72
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/114",
   "title": "Canyon Camp Chair",
   "status": "ACTIVE",
   "totalInventory": 161,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/114",
      "sku": "P4-0114",
      "title": "Default Title",
      "price": "85.65",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 161
           },
           {
            "name": "on_hand",
            "quantity": 161
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/115",
   "title": "Canyon Cookset",
   "status": "ACTIVE",
   "totalInventory": 46,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/115",
      "sku": "P4-0115",
      "title": "Default Title",
      "price": "96.61",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 46
           },
           {
            "name": "on_hand",
            "quantity": 46
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/116",
   "title": "Canyon Hammock",
   "status": "ACTIVE",
   "totalInventory": 100,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/116",
      "sku": "P4-0116",
      "title": "Default Title",
      "price": "60.95",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 100
           },
           {
            "name": "on_hand",
            "quantity": 100
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/117",
   "title": "Canyon Fleece",
   "status": "ACTIVE",
   "totalInventory": 166,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/117",
      "sku": "P4-0117",
      "title": "Default Title",
      "price": "132.77",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 166
           },
           {
            "name": "on_hand",
            "quantity": 166
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/118",
   "title": "Canyon Gaiters",
   "status": "ACTIVE",
   "totalInventory": 104,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/118",
      "sku": "P4-0118",
      "title": "Default Title",
      "price": "153.78",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 104
           },
           {
            "name": "on_hand",
            "quantity": 104
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/119",
   "title": "Canyon Compass",
   "status": "ACTIVE",
   "totalInventory": 159,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/119",
      "sku": "P4-0119",
      "title": "Default Title",
      "price": "13.52",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 159
           },
           {
            "name": "on_hand",
            "quantity": 159
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/120",
   "title": "Canyon Dry Bag",
   "status": "ACTIVE",
   "totalInventory": 80,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/120",
      "sku": "P4-0120",
      "title": "Default Title",
      "price": "101.86",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 80
           },
           {
            "name": "on_hand",
            "quantity": 80
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/121",
   "title": "Forest Tent",
   "status": "ACTIVE",
   "totalInventory": 138,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/121",
      "sku": "P4-0121",
      "title": "Default Title",
      "price": "50.18",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 138
           },
           {
            "name": "on_hand",
            "quantity": 138
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/122",
   "title": "Forest Sleeping Bag",
   "status": "ACTIVE",
   "totalInventory": 179,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/122",
      "sku": "P4-0122",
      "title": "Default Title",
      "price": "205.77",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 179
           },
           {
            "name": "on_hand",
            "quantity": 179
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/123",
   "title": "Forest Stove",
   "status": "ACTIVE",
   "totalInventory": 88,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/123",
      "sku": "P4-0123",
      "title": "Default Title",
      "price": "79.15",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 88
           },
           {
            "name": "on_hand",
            "quantity": 88
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/124",
   "title": "Forest Headlamp",
   "status": "ACTIVE",
   "totalInventory": 74,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/124",
      "sku": "P4-0124",
      "title": "Default Title",
      "price": "119.63",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 74
           },
           {
            "name": "on_hand",
            "quantity": 74
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/125",
   "title": "Forest Backpack",
   "status": "ACTIVE",
   "totalInventory": 155,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/125",
      "sku": "P4-0125",
      "title": "Default Title",
      "price": "136.06",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 155
           },
           {
            "name": "on_hand",
            "quantity": 155
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/126",
   "title": "Forest Water Filter",
   "status": "ACTIVE",
   "totalInventory": 59,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/126",
      "sku": "P4-0126",
      "title": "Default Title",
      "price": "115.02",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 59
           },
           {
            "name": "on_hand",
            "quantity": 59
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/127",
   "title": "Forest Trekking Poles",
   "status": "ACTIVE",
   "totalInventory": 112,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/127",
      "sku": "P4-0127",
      "title": "Default Title",
      "price": "92.24",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 112
           },
           {
            "name": "on_hand",
            "quantity": 112
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/128",
   "title": "Forest Rain Jacket",
   "status": "ACTIVE",
   "totalInventory": 106,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/128",
      "sku": "P4-0128",
      "title": "Default Title",
      "price": "184.11",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 106
           },
           {
            "name": "on_hand",
            "quantity": 106
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/129",
   "title": "Forest Camp Chair",
   "status": "ACTIVE",
   "totalInventory": 175,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/129",
      "sku": "P4-0129",
      "title": "Default Title",
      "price": "171.38",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 175
           },
           {
            "name": "on_hand",
            "quantity": 175
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/130",
   "title": "Forest Cookset",
   "status": "ACTIVE",
   "totalInventory": 198,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/130",
      "sku": "P4-0130",
      "title": "Default Title",
      "price": "65.75",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 198
           },
           {
            "name": "on_hand",
            "quantity": 198
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/131",
   "title": "Forest Hammock",
   "status": "ACTIVE",
   "totalInventory": 60,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/131",
      "sku": "P4-0131",
      "title": "Default Title",
      "price": "199.01",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 60
           },
           {
            "name": "on_hand",
            "quantity": 60
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/132",
   "title": "Forest Fleece",
   "status": "ACTIVE",
   "totalInventory": 136,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/132",
      "sku": "P4-0132",
      "title": "Default Title",
      "price": "112.67",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 136
           },
           {
            "name": "on_hand",
            "quantity": 136
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/133",
   "title": "Forest Gaiters",
   "status": "ACTIVE",
   "totalInventory": 98,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/133",
      "sku": "P4-0133",
      "title": "Default Title",
      "price": "43.77",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 98
           },
           {
            "name": "on_hand",
            "quantity": 98
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/134",
   "title": "Forest Compass",
   "status": "ACTIVE",
   "totalInventory": 114,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/134",
      "sku": "P4-0134",
      "title": "Default Title",
      "price": "87.68",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 114
           },
           {
            "name": "on_hand",
            "quantity": 114
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/135",
   "title": "Forest Dry Bag",
   "status": "ACTIVE",
   "totalInventory": 170,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/135",
      "sku": "P4-0135",
      "title": "Default Title",
      "price": "69.86",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 170
           },
           {
            "name": "on_hand",
            "quantity": 170
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/136",
   "title": "Coast Tent",
   "status": "ACTIVE",
   "totalInventory": 69,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/136",
      "sku": "P4-0136",
      "title": "Default Title",
      "price": "139.67",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 69
           },
           {
            "name": "on_hand",
            "quantity": 69
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/137",
   "title": "Coast Sleeping Bag",
   "status": "ACTIVE",
   "totalInventory": 112,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/137",
      "sku": "P4-0137",
      "title": "Default Title",
      "price": "41.21",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 112
           },
           {
            "name": "on_hand",
            "quantity": 112
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/138",
   "title": "Coast Stove",
   "status": "ACTIVE",
   "totalInventory": 157,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/138",
      "sku": "P4-0138",
      "title": "Default Title",
      "price": "156.66",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 157
           },
           {
            "name": "on_hand",
            "quantity": 157
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/139",
   "title": "Coast Headlamp",
   "status": "ACTIVE",
   "totalInventory": 116,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/139",
      "sku": "P4-0139",
      "title": "Default Title",
      "price": "15.95",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 116
           },
           {
            "name": "on_hand",
            "quantity": 116
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/140",
   "title": "Coast Backpack",
   "status": "ACTIVE",
   "totalInventory": 189,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/140",
      "sku": "P4-0140",
      "title": "Default Title",
      "price": "88.25",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 189
           },
           {
            "name": "on_hand",
            "quantity": 189
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/141",
   "title": "Coast Water Filter",
   "status": "ACTIVE",
   "totalInventory": 88,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/141",
      "sku": "P4-0141",
      "title": "Default Title",
      "price": "125.46",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 88
           },
           {
            "name": "on_hand",
            "quantity": 88
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/142",
   "title": "Coast Trekking Poles",
   "status": "ACTIVE",
   "totalInventory": 82,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/142",
      "sku": "P4-0142",
      "title": "Default Title",
      "price": "94.29",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 82
           },
           {
            "name": "on_hand",
            "quantity": 82
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/143",
   "title": "Coast Rain Jacket",
   "status": "ACTIVE",
   "totalInventory": 119,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/143",
      "sku": "P4-0143",
      "title": "Default Title",
      "price": "142.88",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 119
           },
           {
            "name": "on_hand",
            "quantity": 119
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/144",
   "title": "Coast Camp Chair",
   "status": "ACTIVE",
   "totalInventory": 134,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/144",
      "sku": "P4-0144",
      "title": "Default Title",
      "price": "77.19",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 134
           },
           {
            "name": "on_hand",
            "quantity": 134
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/145",
   "title": "Coast Cookset",
   "status": "ACTIVE",
   "totalInventory": 119,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/145",
      "sku": "P4-0145",
      "title": "Default Title",
      "price": "65.82",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 119
           },
           {
            "name": "on_hand",
            "quantity": 119
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/146",
   "title": "Coast Hammock",
   "status": "ACTIVE",
   "totalInventory": 100,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/146",
      "sku": "P4-0146",
      "title": "Default Title",
      "price": "58.78",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 100
           },
           {
            "name": "on_hand",
            "quantity": 100
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/147",
   "title": "Coast Fleece",
   "status": "ACTIVE",
   "totalInventory": 50,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/147",
      "sku": "P4-0147",
      "title": "Default Title",
      "price": "131.69",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 50
           },
           {
            "name": "on_hand",
            "quantity": 50
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/148",
   "title": "Coast Gaiters",
   "status": "ACTIVE",
   "totalInventory": 124,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/148",
      "sku": "P4-0148",
      "title": "Default Title",
      "price": "185.29",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 124
           },
           {
            "name": "on_hand",
            "quantity": 124
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/149",
   "title": "Coast Compass",
   "status": "ACTIVE",
   "totalInventory": 113,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/149",
      "sku": "P4-0149",
      "title": "Default Title",
      "price": "72.79",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 113
           },
           {
            "name": "on_hand",
            "quantity": 113
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  },
  {
   "id": "gid://shopify/Product/150",
   "title": "Coast Dry Bag",
   "status": "ACTIVE",
   "totalInventory": 113,
   "tracksInventory": true,
   "variants": {
    "nodes": [
     {
      "id": "gid://shopify/ProductVariant/150",
      "sku": "P4-0150",
      "title": "Default Title",
      "price": "39.12",
      "inventoryItem": {
       "tracked": true,
       "inventoryLevels": {
        "nodes": [
         {
          "location": {
           "name": "Location 1"
          },
          "quantities": [
           {
            "name": "available",
            "quantity": 113
           },
           {
            "name": "on_hand",
            "quantity": 113
           },
           {
            "name": "committed",
            "quantity": 0
           },
           {
            "name": "incoming",
            "quantity": 0
           }
          ]
         }
        ]
       }
      }
     }
    ]
   }
  }
 ]
}
