package com.scan2plate.restaurantpos;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(OfflineNavPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
